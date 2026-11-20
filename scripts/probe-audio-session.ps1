param(
  [int]$TargetPid = 0,
  [string]$ProcName = '',
  [switch]$SelfTest,
  [ValidateSet('', 'on', 'off')][string]$SetMute = ''
)

# 枚举默认播放设备上的所有音频会话，按 PID 报告静音状态。
# 可按 PID 对单个会话 SetMute —— 用于验证「静音按钮能否控制引擎输出的声音」。
$src = @'
using System;
using System.Text;
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
  // IAudioSessionManager2 继承 IAudioSessionManager，vtable 前两个方法是父接口的。
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

public static class MoyuSession {
  public static string Run(string procName, int targetPid, int setMute) {
    var sb = new StringBuilder();
    try {
      var t = Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"));
      var en = (IMMDeviceEnumerator)Activator.CreateInstance(t);
      IMMDevice dev;
      int hr = en.GetDefaultAudioEndpoint(0, 0, out dev);
      if (hr != 0) return "GetDefaultAudioEndpoint hr=" + hr;
      Guid iid = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
      object mo;
      hr = dev.Activate(ref iid, 23, IntPtr.Zero, out mo);
      if (hr != 0) return "Activate hr=" + hr;
      var mgr = (IAudioSessionManager2)mo;
      IAudioSessionEnumerator list;
      hr = mgr.GetSessionEnumerator(out list);
      sb.AppendLine("GetSessionEnumerator hr=" + hr);
      if (hr != 0 || list == null) return sb.ToString();
      int count; list.GetCount(out count);
      sb.AppendLine("sessions=" + count);
      for (int i = 0; i < count; i++) {
        IAudioSessionControl ctl;
        hr = list.GetSession(i, out ctl);
        if (hr != 0 || ctl == null) continue;
        int pid = 0;
        var c2 = ctl as IAudioSessionControl2;
        if (c2 != null) c2.GetProcessId(out pid);
        var vol = ctl as ISimpleAudioVolume;
        int mute = -1;
        if (vol != null) vol.GetMute(out mute);
        string name = "?";
        try { name = Process.GetProcessById(pid).ProcessName; } catch (Exception) {}
        sb.AppendLine(pid + "|" + name + "|mute=" + mute);
        bool match = (targetPid > 0 && pid == targetPid) ||
          (procName.Length > 0 && name.IndexOf(procName, StringComparison.OrdinalIgnoreCase) >= 0);
        if (match && vol != null && setMute >= 0) {
          hr = vol.SetMute(setMute, IntPtr.Zero);
          int after = -1; vol.GetMute(out after);
          sb.AppendLine("SET " + pid + "|" + name + " hr=" + hr + " -> mute=" + after);
        }
      }
    } catch (Exception e) { sb.AppendLine("ERR " + e.GetType().Name + ": " + e.Message); }
    return sb.ToString();
  }
}
'@

Add-Type -TypeDefinition $src -ErrorAction Stop
$mute = -1
if ($SetMute -eq 'on') { $mute = 1 }
elseif ($SetMute -eq 'off') { $mute = 0 }
if ($SelfTest) {
  Add-Type -AssemblyName System.Windows.Forms
  $wav = "C:\Windows\Media\Windows Ding.wav"
  if (-not (Test-Path $wav)) { $wav = (Get-ChildItem "C:\Windows\Media\*.wav" | Select-Object -First 1).FullName }
  $player = New-Object System.Media.SoundPlayer($wav)
  $player.PlayLooping()
  Start-Sleep -Milliseconds 700
  Write-Output "--- self pid=$PID wav=$wav ---"
  Write-Output ([MoyuSession]::Run("", $PID, 1))
  Write-Output ([MoyuSession]::Run("", $PID, 0))
  $player.Stop()
  exit
}

Write-Output ([MoyuSession]::Run([string]$ProcName, $TargetPid, $mute))
