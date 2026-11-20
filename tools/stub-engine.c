/* stub-engine.c —— 测试用的假引擎：吃掉命令行参数然后一直活着。
 *
 * 用途：真实 -vnet 链路里，端口是**引擎** listen、应用 connect。想在没有 iPhone 的
 * 情况下把「收流 → IPC → WebCodecs → canvas」整条跑起来，就得让应用以为自己起了引擎
 * （进程存在、argv 被忽略），同时把 7788 让给我们自己的重放服务器。
 *
 * 编译：gcc -O2 -o stub-engine.exe stub-engine.c
 */
#include <windows.h>

int main(int argc, char **argv) {
    (void)argc; (void)argv;
    /* 300 秒足够跑完任何一次观测量测；父进程退出后它会被一起 reap。 */
    Sleep(300000);
    return 0;
}
