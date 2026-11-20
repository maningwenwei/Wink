param(
  [string]$ProcName = 'uxplay',
  [ValidateSet('on', 'off')][string]$SetMute = 'off',
  [int]$WaitSeconds = 6,
  [ValidateSet('once', 'server')][string]$Action = 'once'
)

# 把「进程名匹配」的 WASAPI 音频会话设为静音 / 取消静音。
#
# AirPlay 声音由 uxplay-windows.exe 自己通过 WASAPI 输出，不经过 Electron 的
# WebContents，所以 setAudioMuted 对它无效。这里走 Windows 音量合成器的
# ISimpleAudioVolume::SetMute，只影响引擎这一个应用，不动系统主音量。
#
# 音频会话要等 iPhone 连上、音频管道起来之后才注册，所以 GetSessionEnumerator
# 可能暂时看不到它 —— -WaitSeconds 期间每 400ms 重试一次，命中就退出。
$src = @'
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using System.Diagnostics;

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int flow, int mask, out IntPtr collection);
  [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
  [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
  [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
  [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
  [PreserveSig] int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object obj);
  [PreserveSig] int OpenPropertyStore(int access, out IntPtr store);
  [PreserveSig] int GetId(out IntPtr id);
  [PreserveSig] int GetState(out int state);
}
[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionManager2 {
  [PreserveSig] int GetAudioSessionControl(IntPtr g, int cross, out IAudioSessionControl ctl);
  [PreserveSig] int GetSimpleAudioVolume(IntPtr g, int cross, out ISimpleAudioVolume vol);
  [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e);
  [PreserveSig] int RegisterSessionNotification(IntPtr n);
  [PreserveSig] int UnregisterSessionNotification(IntPtr n);
  [PreserveSig] int RegisterDuckNotification(IntPtr id, IntPtr n);
  [PreserveSig] int UnregisterDuckNotification(IntPtr n);
}
[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionEnumerator {
  [PreserveSig] int GetCount(out int count);
  [PreserveSig] int GetSession(int index, out IAudioSessionControl ctl);
}
[ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionControl {
  [PreserveSig] int GetState(out int state);
  [PreserveSig] int GetDisplayName(out IntPtr p);
  [PreserveSig] int SetDisplayName(IntPtr p, IntPtr ctx);
  [PreserveSig] int GetIconPath(out IntPtr p);
  [PreserveSig] int SetIconPath(IntPtr p, IntPtr ctx);
  [PreserveSig] int GetGroupingParam(out Guid g);
  [PreserveSig] int SetGroupingParam(ref Guid g, IntPtr ctx);
  [PreserveSig] int RegisterAudioSessionNotification(IntPtr n);
  [PreserveSig] int UnregisterAudioSessionNotification(IntPtr n);
}
[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionControl2 {
  [PreserveSig] int GetState(out int state);
  [PreserveSig] int GetDisplayName(out IntPtr p);
  [PreserveSig] int SetDisplayName(IntPtr p, IntPtr ctx);
  [PreserveSig] int GetIconPath(out IntPtr p);
  [PreserveSig] int SetIconPath(IntPtr p, IntPtr ctx);
  [PreserveSig] int GetGroupingParam(out Guid g);
  [PreserveSig] int SetGroupingParam(ref Guid g, IntPtr ctx);
  [PreserveSig] int RegisterAudioSessionNotification(IntPtr n);
  [PreserveSig] int UnregisterAudioSessionNotification(IntPtr n);
  [PreserveSig] int GetSessionIdentifier(out IntPtr p);
  [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr p);
  [PreserveSig] int GetProcessId(out int pid);
  [PreserveSig] int IsSystemSoundsSession();
  [PreserveSig] int SetDuckingPreference(int optOut);
}
[ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ISimpleAudioVolume {
  [PreserveSig] int SetMasterVolume(float level, IntPtr ctx);
  [PreserveSig] int GetMasterVolume(out float level);
  [PreserveSig] int SetMute(int mute, IntPtr ctx);
  [PreserveSig] int GetMute(out int mute);
}

[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume {
  [PreserveSig] int RegisterControlChangeNotify(IntPtr n);
  [PreserveSig] int UnregisterControlChangeNotify(IntPtr n);
  [PreserveSig] int GetChannelCount(out int c);
  [PreserveSig] int SetMasterVolumeLevel(float level, IntPtr ctx);
  [PreserveSig] int SetMasterVolumeLevelScalar(float level, IntPtr ctx);
  [PreserveSig] int GetMasterVolumeLevel(out float level);
  [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
  [PreserveSig] int SetChannelVolumeLevel(uint ch, float level, IntPtr ctx);
  [PreserveSig] int SetChannelVolumeLevelScalar(uint ch, float level, IntPtr ctx);
  [PreserveSig] int GetChannelVolumeLevel(uint ch, out float level);
  [PreserveSig] int GetChannelVolumeLevelScalar(uint ch, out float level);
  [PreserveSig] int SetMute(int mute, IntPtr ctx);
  [PreserveSig] int GetMute(out int mute);
  [PreserveSig] int GetVolumeStepInfo(out int step, out int count);
  [PreserveSig] int VolumeStepUp(IntPtr ctx);
  [PreserveSig] int VolumeStepDown(IntPtr ctx);
  [PreserveSig] int QueryHardwareSupport(out int mask);
  [PreserveSig] int GetVolumeRange(out float min, out float max, out float inc);
}

public static class MoyuAudioSession {
  static int lastMute = -1;

  // "Hide -> mute everything" used to recompile this C# on every call: a fresh
  // powershell.exe plus Add-Type costs 1.5-2.5s, which is why the sound only
  // died a beat after the window was gone. In server mode the type is compiled
  // once and these entry points answer in a few milliseconds.
  static IAudioEndpointVolume Endpoint() {
    var t = Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"));
    var en = (IMMDeviceEnumerator)Activator.CreateInstance(t);
    IMMDevice dev;
    if (en.GetDefaultAudioEndpoint(0, 0, out dev) != 0) return null;
    Guid iid = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
    object o;
    if (dev.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) return null;
    return o as IAudioEndpointVolume;
  }

  // Stateless on purpose. The endpoint mute flag belongs to the whole machine
  // (user hotkeys, conferencing apps, volume mixer). Remembering a "state to
  // put back" inside this host caused two real bugs:
  //   1) this process can be restarted (command timeout / crash / app relaunch),
  //      so the remembered value vanished and the machine stayed muted forever;
  //   2) writing it back on show silently overwrote whatever the USER did
  //      while the float was hidden -- that is the "conflict" users reported.
  // Ownership now lives in audio.js: here we only read or set, never guess.
  //   want  1 -> SetMute(1)   0 -> SetMute(0)
  //         2 -> force unmute (probe / repair path)
  //        <0 -> read only
  public static string Sys(int want) {
    var vol = Endpoint();
    if (vol == null) return "{\"ok\":false,\"err\":\"endpoint\"}";
    int prev = -1;
    vol.GetMute(out prev);
    if (want == 1) { vol.SetMute(1, IntPtr.Zero); }
    else if (want == 0 || want == 2) { vol.SetMute(0, IntPtr.Zero); }
    int now = -1;
    vol.GetMute(out now);
    return "{\"ok\":true,\"muted\":" + now + ",\"prev\":" + prev + "}";
  }

  public static string MuteOnce(string procName, int setMute) {
    int hits = -1;
    try { hits = ApplyOnce(procName, setMute); } catch (Exception) { hits = -1; }
    if (hits <= 0) return "{\"ok\":false,\"res\":\"NOSESSION\"}";
    return "{\"ok\":true,\"res\":\"OK " + hits + " mute=" + lastMute + "\"}";
  }
  static int ApplyOnce(string procName, int setMute) {
    var t = Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"));
    var en = (IMMDeviceEnumerator)Activator.CreateInstance(t);
    IMMDevice dev;
    int hr = en.GetDefaultAudioEndpoint(0, 0, out dev);
    if (hr != 0) return -1;
    Guid iid = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
    object mo;
    hr = dev.Activate(ref iid, 23, IntPtr.Zero, out mo);
    if (hr != 0) return -1;
    var mgr = (IAudioSessionManager2)mo;
    IAudioSessionEnumerator list;
    hr = mgr.GetSessionEnumerator(out list);
    if (hr != 0 || list == null) return -1;
    int count;
    list.GetCount(out count);
    int hits = 0;
    for (int i = 0; i < count; i++) {
      IAudioSessionControl ctl;
      hr = list.GetSession(i, out ctl);
      if (hr != 0 || ctl == null) continue;
      int pid = 0;
      var c2 = ctl as IAudioSessionControl2;
      if (c2 != null) c2.GetProcessId(out pid);
      string name = "";
      try { name = Process.GetProcessById(pid).ProcessName; } catch (Exception) {}
      if (procName.Length > 0 && name.IndexOf(procName, StringComparison.OrdinalIgnoreCase) < 0) continue;
      var vol = ctl as ISimpleAudioVolume;
      if (vol == null) continue;
      vol.SetMute(setMute, IntPtr.Zero);
      int after = -1;
      vol.GetMute(out after);
      lastMute = after;
      hits++;
    }
    return hits;
  }

  public static string Run(string procName, int setMute, int waitMs) {
    int deadline = Environment.TickCount + waitMs;
    do {
      int hits = -2;
      try { hits = ApplyOnce(procName, setMute); }
      catch (Exception) { hits = -2; }
      if (hits > 0) return "OK " + hits + " mute=" + lastMute;
      if (deadline <= Environment.TickCount) break;
      Thread.Sleep(400);
    } while (true);
    return "NOSESSION";
  }
}
'@

Add-Type -TypeDefinition $src -ErrorAction Stop

# ---- server: warm host, one command per line from stdin ----
# Spawning powershell.exe + Add-Type costs 1.5-2.5s. The float window hides in
# one frame, so the sound must die in one frame too: keep this process alive,
# compile once, then answer each command in a few milliseconds.
#   mute <0|1> [proc]   mute / unmute that app's WASAPI session
#   sys get             read the endpoint mute flag (read-only)
#   sys set <0|1>       set the endpoint mute flag; NO hidden state is kept
#   sys 1|0|2           legacy aliases kept for the probes / repair path
#   exit                leave
# One JSON line comes back for every command; EOF means the parent is gone.
if ($Action -eq 'server') {
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line.Length -eq 0) { continue }
    $parts = $line -split '\s+'
    $cmd = $parts[0].ToLower()
    $out = '{"ok":false}'
    try {
      if ($cmd -eq 'exit') { break }
      elseif ($cmd -eq 'mute') {
        $want = 0
        if ($parts.Count -gt 1 -and $parts[1] -eq '1') { $want = 1 }
        $proc = $ProcName
        if ($parts.Count -gt 2) { $proc = $parts[2] }
        $out = [MoyuAudioSession]::MuteOnce([string]$proc, $want)
      }
      elseif ($cmd -eq 'sys') {
        # Default is READ-ONLY. An unknown word must never write to the
        # machine-wide endpoint by accident.
        $want = -1
        if ($parts.Count -gt 1) {
          if ($parts[1] -eq '1') { $want = 1 }
          elseif ($parts[1] -eq '0') { $want = 0 }
          elseif ($parts[1] -eq '2') { $want = 2 }
          elseif ($parts[1] -eq 'set' -and $parts.Count -gt 2) {
            if ($parts[2] -eq '1') { $want = 1 }
            elseif ($parts[2] -eq '0') { $want = 0 }
          }
          # 'get' (and anything unrecognised) stays read-only
        }
        $out = [MoyuAudioSession]::Sys($want)
      }
    } catch { $out = '{"ok":false,"err":true}' }
    [Console]::Out.WriteLine($out)
    [Console]::Out.Flush()
  }
  exit 0
}

$mute = if ($SetMute -eq 'on') { 1 } else { 0 }
$wait = [Math]::Max(0, [Math]::Min(20000, $WaitSeconds * 1000))
Write-Output ([MoyuAudioSession]::Run([string]$ProcName, $mute, $wait))
