/**
 * vnet-sender-test.cpp —— 直接对引擎里那份「真实发送代码」做单元测试。
 *
 * 被测对象就是 wink-vnet.h（uxplay.cpp 里 #include 的同一份文件，不是副本），
 * 所以这里过就等于引擎里过。
 *
 * 要证明的四件事，全部对应「浮窗隐藏后手机会停推、画面回不来」这条 bug：
 *
 *   T1 正常收：不再赘述，防回归。
 *   T2 **读端完全停读 3 秒**（等价于浮窗隐藏期间主进程没读 socket）：
 *        - 每次 wink_vnet_emit 都必须毫秒级返回（它是 AirPlay UDP 线程，
 *          稍有等待 RTP 就收不进来，手机随即停推）；
 *        - 连接一个字节都不能关（1.0.50 会在这里 closesocket）。
 *   T3 停读超过 WINK_VNET_STUCK_MS 后新连接进来 → 立刻换掉僵死 fd 并补发
 *      SPS/IDR（1.0.50 的死 fd 会让新连接永远等不到 accept）。
 *   T4 读端进程消失（RST）→ 只断这一条，新连接马上被认领。
 */

/* 就是 uxplay.cpp include 的那个文件本体，不是副本 */
#include "../../../../AppData/Local/wink-build/src/libuxplay-master/wink-vnet.h"

#include <string>
#include <vector>
#include <thread>
#include <atomic>
#include <mutex>

static int fails = 0;
static int oks = 0;

static void check(const char *name, bool cond, const std::string &detail = "") {
    if (cond) { oks++; printf("  OK   %s\n", name); }
    else { fails++; printf("  FAIL %s%s%s\n", name, detail.empty() ? "" : " -> ", detail.c_str()); }
}

static void sleep_ms(int ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }

/* ---------- 模拟手机码流：SPS+PPS / IDR / P ---------- */
static const int PAYLOAD = 60000;
static std::vector<unsigned char> mk_sps() {
    std::vector<unsigned char> v(600, 0x11);
    v[0] = 0; v[1] = 0; v[2] = 0; v[3] = 1; v[4] = 0x67;
    v[5] = 0; v[6] = 0; v[7] = 1; v[8] = 0x68;
    return v;
}
static std::vector<unsigned char> mk_au(int nal, int len) {
    std::vector<unsigned char> v((size_t)len, 0x42);
    v[0] = 0; v[1] = 0; v[2] = 0; v[3] = 1; v[4] = (unsigned char)nal;
    return v;
}

/* ---------- 读端：可以随时「停读」，用来模拟浮窗隐藏 ---------- */
struct Reader {
    SOCKET s = INVALID_SOCKET;
    std::thread th;
    std::atomic<bool> paused{false};
    std::atomic<bool> stop{false};
    std::atomic<int> frames{0};
    std::atomic<int> errors{0};
    std::atomic<int> firstNal{-1};
    std::mutex mu;

    bool connect_to(int port) {
        s = socket(AF_INET, SOCK_STREAM, 0);
        if (s == INVALID_SOCKET) return false;
        /* 收窗口压小，让发送端的缓冲很快被灌满 —— 真实场景里 30fps 的
         * 77KB IDR 也是同样的效果，只是慢几秒 */
        int rcv = 16 * 1024;
        setsockopt(s, SOL_SOCKET, SO_RCVBUF, (const char *)&rcv, sizeof(rcv));
        struct sockaddr_in a;
        memset(&a, 0, sizeof(a));
        a.sin_family = AF_INET;
        a.sin_port = htons((unsigned short)port);
        a.sin_addr.s_addr = inet_addr("127.0.0.1");
        if (connect(s, (struct sockaddr *)&a, sizeof(a)) == SOCKET_ERROR) {
            closesocket(s); s = INVALID_SOCKET; return false;
        }
        stop = false;
        th = std::thread([this] { loop(); });
        return true;
    }

    void loop() {
        std::vector<unsigned char> buf;
        unsigned char tmp[16384];
        while (!stop) {
            if (paused) { sleep_ms(20); continue; }
            int n = recv(s, (char *)tmp, sizeof(tmp), 0);
            if (n <= 0) { if (!stop) errors++; return; }
            const unsigned char *p = tmp;
            while (n > 0) {
                size_t need = buf.size() < 16 ? 16 - buf.size() : 0;
                size_t take = need ? (size_t)n < need ? (size_t)n : need : 0;
                buf.insert(buf.end(), p, p + take);
                p += take; n -= (int)take;
                if (buf.size() < 16) break;
                uint32_t len = ((uint32_t)buf[0] << 24) | ((uint32_t)buf[1] << 16) |
                               ((uint32_t)buf[2] << 8) | buf[3];
                if (len == 0 || len > 4u * 1024 * 1024) { errors++; buf.clear(); break; }
                size_t want = 16 + len;
                size_t more = want - buf.size();
                size_t got = (size_t)n < more ? (size_t)n : more;
                buf.insert(buf.end(), p, p + got);
                p += got; n -= (int)got;
                if (buf.size() < want) break;
                if (firstNal.load() < 0 && len > 5)
                    firstNal = buf[16 + 4] & 0x1f;
                frames++;
                buf.erase(buf.begin(), buf.begin() + (long)want);
            }
        }
    }

    void pause()  { paused = true; }
    void resume() { paused = false; }
    void close_all() {
        stop = true;
        if (s != INVALID_SOCKET) { shutdown(s, SD_BOTH); closesocket(s); s = INVALID_SOCKET; }
        if (th.joinable()) th.join();
    }
};

static const int PORT = 7811;

int main() {
    wink_vnet_start(PORT);

    std::vector<unsigned char> sps = mk_sps();
    std::vector<unsigned char> idr = mk_au(5, PAYLOAD);
    std::vector<unsigned char> pfr = mk_au(0x41, PAYLOAD);

    /* emit 一次并返回耗时（微秒） */
    auto emit = [&](const std::vector<unsigned char> &au) -> double {
        auto t0 = std::chrono::steady_clock::now();
        wink_vnet_emit(au.data(), (int)au.size(), 1234);
        auto t1 = std::chrono::steady_clock::now();
        return std::chrono::duration<double, std::micro>(t1 - t0).count();
    };

    printf("\n== T1 正常收发 ==\n");
    Reader r1;
    check("读端连上 listen 端口", r1.connect_to(PORT));
    emit(sps); emit(idr);
    for (int i = 0; i < 60; i++) { emit(pfr); sleep_ms(5); }
    sleep_ms(300);
    check("收到帧", r1.frames.load() >= 60, "frames=" + std::to_string(r1.frames.load()));
    check("首帧是 SPS (nal 7)", r1.firstNal.load() == 7, "nal=" + std::to_string(r1.firstNal.load()));
    check("无错位帧", r1.errors.load() == 0, "errors=" + std::to_string(r1.errors.load()));

    printf("\n== T2 读端停读 3 秒（模拟浮窗隐藏）==\n");
    r1.pause();
    double worst = 0;
    for (int i = 0; i < 90; i++) {           // 90 帧 = 3 秒的 30fps
        double us = emit(pfr);
        if (us > worst) worst = us;
        sleep_ms(33);
    }
    check("停读期间连接没有被关掉", wink_vnet_client != INVALID_SOCKET);
    check("停读期间 emit 不会阻塞（最慢 < 2ms）", worst < 2000,
          "worst=" + std::to_string((long)worst) + "us");
    check("停读期间确实触发了背压丢帧", wink_vnet_drop_count > 0,
          "dropped=" + std::to_string((long)wink_vnet_drop_count));
    const int before = r1.frames.load();
    r1.resume();
    for (int i = 0; i < 20; i++) { emit(pfr); sleep_ms(33); }
    sleep_ms(300);
    check("恢复读之后立刻继续出帧", r1.frames.load() > before,
          std::to_string(before) + " -> " + std::to_string(r1.frames.load()));
    check("恢复后字节流没有错位", r1.errors.load() == 0,
          "errors=" + std::to_string(r1.errors.load()));

    printf("\n== T3 停读超过 4 秒 + 新连接进来 ==\n");
    r1.pause();
    wink_vnet_drop_count = 0;
    long long t0 = (long long)wink_vnet_now_ms();
    while ((long long)wink_vnet_now_ms() - t0 < 4600) { emit(pfr); sleep_ms(33); }
    check("长时间停读仍然没有因为超时断开", wink_vnet_client != INVALID_SOCKET);
    Reader r2;
    check("新连接（模拟浮窗重开）连上", r2.connect_to(PORT));
    for (int i = 0; i < 20; i++) { emit(pfr); sleep_ms(20); }
    sleep_ms(300);
    check("僵死 fd 被替换，新连接收到帧", r2.frames.load() > 0,
          "frames=" + std::to_string(r2.frames.load()));
    check("新连接以 SPS 起头（补发了参数集）", r2.firstNal.load() == 7,
          "nal=" + std::to_string(r2.firstNal.load()));
    check("新连接字节流无错位", r2.errors.load() == 0,
          "errors=" + std::to_string(r2.errors.load()));
    r1.close_all();

    printf("\n== T4 读端消失（RST）后新连接被立刻认领 ==\n");
    r2.close_all();
    for (int i = 0; i < 5; i++) { emit(pfr); sleep_ms(20); }
    Reader r3;
    check("新连接连上", r3.connect_to(PORT));
    for (int i = 0; i < 10; i++) { emit(pfr); sleep_ms(20); }
    sleep_ms(300);
    check("新连接收到帧", r3.frames.load() > 0, "frames=" + std::to_string(r3.frames.load()));
    r3.close_all();

    printf("\n%s (%d 项通过)\n", fails ? "[FAIL]" : "[PASS]", oks);
    if (fails) printf("%d 项未通过\n", fails);
    return fails ? 1 : 0;
}
