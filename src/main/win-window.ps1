param(
  [string]$Action = 'list',
  [string]$ProcName = 'uxplay-windows',
  [string]$OwnerPids = '',
  [long]$Target = 0,
  [int]$X = 0,
  [int]$Y = 0,
  [int]$W = 0,
  [int]$H = 0,
  [string]$Layer = 'bottom',
  [int]$Show = 0,
  [long]$Epoch = -1
)

# Enumerate / reposition / tuck away the engine's video window.
#
# list  : every top-level window owned by $ProcName -> JSON array
#         (hwnd,title,class,x,y,w,h,visible,iconic)
# place : make $Target a borderless window pinned behind everything at the rect
# tuck  : place $Target at the rect (only if drifted > 6px / hidden / iconic)
#         AND hide every OTHER visible window of the same process tree.
#         The engine never closes its video window after a disconnect, and Qt
#         stretches its tray-icon message window to the same size as the video
#         window (bottom-right of the screen). Both must never be seen.
# vis   : show (1) / hide (0) one window
# server: stay alive and read one command per line from stdin, answering with
#         one JSON line each. Spawning powershell costs ~600-900ms, which is
#         exactly why the engine window used to trail behind the float during
#         drags and why the alignment guard could not run tighter.
#           list
#           place <hwnd> <x> <y> <w> <h> <bottom|top>
#           tuck  <hwnd> <x> <y> <w> <h> [epoch]
#           vis   <hwnd> <0|1>
#           gate  <epoch> <0|1>   (float show/hide: authoritative visibility)
#
# gate solves the "engine window leaks out when the float is hidden" bug:
# every tuck/place uses SWP_SHOWWINDOW, so ANY tuck left in the host queue
# re-shows the window right after SW_HIDE. The host now owns the visibility
# state, and carries an epoch so tuck commands queued before a show/hide
# transition are discarded instead of being executed late.
#
# The video surface is a separate top-level window created by GStreamer inside the
# engine process, so Process.MainWindowHandle is not enough - we must walk EnumWindows.
#
# IMPORTANT (two traps this file must respect):
#   1. powershell.exe (5.1) reads a .ps1 WITHOUT a BOM as ANSI. Any non-ASCII byte
#      in here gets mis-decoded and can swallow the following lines of code, which
#      silently breaks everything after it. Keep this file ASCII-only.
#   2. PowerShell variable names are case-insensitive, so $h and $H are the same
#      variable. Never name a local $h while the -H parameter exists, or the
#      parameter gets overwritten (that once resized windows to height=HWND value,
#      clamped by Windows to 65535, which made desktop capture fail with
#      E_INVALIDARG -> black picture).

Add-Type -Namespace Moyu -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
[DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
public struct RECT { public int Left, Top, Right, Bottom; }
'@

function Get-Rect([IntPtr]$handle) {
  $r = New-Object Moyu.Win+RECT
  if ([Moyu.Win]::GetWindowRect($handle, [ref]$r)) {
    return @{ x = $r.Left; y = $r.Top; w = $r.Right - $r.Left; h = $r.Bottom - $r.Top }
  }
  return @{ x = 0; y = 0; w = 0; h = 0 }
}

$targetPids = @()
# ProcName is a guess about how the engine names itself; OwnerPids is the truth
# (we spawned it, so we know the PID). Accept both, and never let an empty
# -ProcName fall through to Get-Process (it throws and kills the whole script).
if ($ProcName) {
  foreach ($p in (Get-Process -Name $ProcName -ErrorAction SilentlyContinue)) {
    if (-not ($targetPids -contains $p.Id)) { $targetPids += $p.Id }
  }
}
if ($OwnerPids) {
  $roots = @()
  foreach ($piece in ($OwnerPids -split ',')) {
    $n = 0
    if ([int]::TryParse($piece.Trim(), [ref]$n) -and $n -gt 0) { $roots += $n }
  }
  # Walk the process tree: EnumWindows only sees the process that actually owns
  # the window, and the GUI may hand the pipeline to a child process.
  $tree = @()
  if ($roots.Count -gt 0) {
    $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Select-Object ProcessId, ParentProcessId
    $queue = New-Object System.Collections.Queue
    foreach ($r in $roots) { $queue.Enqueue($r) }
    while ($queue.Count -gt 0) {
      $cur = [int]$queue.Dequeue()
      if ($tree -contains $cur) { continue }
      $tree += $cur
      foreach ($c in $procs) {
        if ([int]$c.ParentProcessId -eq $cur) { $queue.Enqueue([int]$c.ProcessId) }
      }
    }
  }
  foreach ($n in $tree) {
    if (-not ($targetPids -contains $n)) { $targetPids += $n }
  }
}
$script:targetPids = $targetPids

# Enumerate every top-level window owned by the engine process tree.
# Accumulates into a script-scope list: the EnumWindows delegate runs outside the
# PowerShell call stack, so locals of the calling function are NOT guaranteed to
# be visible inside the callback - script scope always is.
function Get-Rows {
  $script:rows = New-Object System.Collections.ArrayList
  $cb = [Moyu.Win+EnumWindowsProc]{
    param($win, $p)
    $ownerId = 0
    [void][Moyu.Win]::GetWindowThreadProcessId($win, [ref]$ownerId)
    if ($script:targetPids -contains [int]$ownerId) {
      $sb = New-Object System.Text.StringBuilder 512
      [void][Moyu.Win]::GetWindowTextW($win, $sb, 512)
      $cb2 = New-Object System.Text.StringBuilder 256
      [void][Moyu.Win]::GetClassNameW($win, $cb2, 256)
      $r = New-Object Moyu.Win+RECT
      [void][Moyu.Win]::GetWindowRect($win, [ref]$r)
      [void]$script:rows.Add([pscustomobject]@{
        hwnd    = $win.ToInt64()
        title   = $sb.ToString()
        cls     = $cb2.ToString()
        visible = [Moyu.Win]::IsWindowVisible($win)
        iconic  = [Moyu.Win]::IsIconic($win)
        x = $r.Left; y = $r.Top; w = $r.Right - $r.Left; h = $r.Bottom - $r.Top
      })
    }
    return $true
  }
  [void][Moyu.Win]::EnumWindows($cb, [IntPtr]::Zero)
  return @($script:rows)
}

# Authoritative visibility state, owned by the resident host. 1 = float is
# fully visible and the engine video window may be shown; 0 = nothing belonging
# to the engine may be on screen. The epoch invalidates tuck requests that were
# already queued when the state flipped.
$script:engineGate = 1
$script:engineEpoch = 0

# Hide every visible engine window except $keepHwnd. Not just the bound video
# window: the Qt tray message window, the stale post-disconnect mirror window
# and a freshly created unbound video window are exactly what users see next
# to the float when it is hidden or dragged.
function Hide-Engine-Windows([long]$keepHwnd) {
  $hidden = @()
  foreach ($row in @(Get-Rows)) {
    if ([long]$row.hwnd -eq $keepHwnd) { continue }
    if ($row.visible -and -not $row.iconic) {
      [void][Moyu.Win]::ShowWindow([IntPtr]::new([long]$row.hwnd), 0)
      $hidden += [string]$row.title
    }
  }
  return $hidden
}

function Invoke-Gate([long]$epoch, [int]$show) {
  $script:engineEpoch = $epoch
  $script:engineGate = $show
  if ($show -eq 0) {
    $hidden = @(Hide-Engine-Windows -1)
    return @{ ok = $true; gate = 0; hidden = $hidden }
  }
  return @{ ok = $true; gate = 1 }
}

# Strip the caption, pin the window behind everything, make it mouse-transparent.
function Invoke-Place([IntPtr]$handle, [int]$px, [int]$py, [int]$pw, [int]$ph, [string]$layer) {
  # place is a geometry action: it may still run while the float is hidden, but
  # it must NOT re-show the window. Drop SWP_SHOWWINDOW in that case and hide it
  # again afterwards. (Invoke-Tuck is blocked outright when gated; see below.)
  $gated = ($script:engineGate -eq 0)
  # strip caption / thick frame so the captured surface is pure video
  $style = [Moyu.Win]::GetWindowLong($handle, -16)
  $style = $style -band (-bnot 0x00C00000) -band (-bnot 0x00040000)
  $style = $style -bor 0x80000000   # WS_POPUP keeps it a plain surface
  [void][Moyu.Win]::SetWindowLong($handle, -16, $style)
  # Extended style - this is what keeps the video window from ever stealing the
  # foreground. Without it a click / Alt-Tab / the engine calling activateWindow()
  # raises the engine window above the float window, and the user sees the phone
  # picture sitting next to (or on top of) the small window instead of inside it.
  #   WS_TOOLWINDOW  (0x00000080) - no taskbar button, no Alt-Tab entry
  #   WS_EX_NOACTIVATE  (0x08000000) - never becomes the active window on click
  #   WS_EX_APPWINDOW   (0x00040000) - must be cleared or TOOLWINDOW is ignored
  #   WS_EX_TRANSPARENT (0x00000020) - mouse passes through.
  #     The video window exists only to be captured; it never needs the mouse.
  #     Without this, if the engine raises its window (Qt activateWindow) the
  #     pointer lands on the video surface instead of the float window: clicks
  #     and wheel stop working and the user reads it as "the mouse got captured
  #     into the mirror picture".
  $ex = [Moyu.Win]::GetWindowLong($handle, -20)
  $ex = $ex -band (-bnot 0x00040000)
  $ex = $ex -bor 0x00000080 -bor 0x08000000 -bor 0x00000020
  [void][Moyu.Win]::SetWindowLong($handle, -20, $ex)
  # HWND_BOTTOM=1 (hide behind the float window) or HWND_TOP=0 (fallback: let the
  # user actually see the engine window when capturing it failed)
  $after = [IntPtr]1
  if ($layer -eq 'top') { $after = [IntPtr]0 }
  # SWP_SHOWWINDOW|SWP_NOACTIVATE|SWP_FRAMECHANGED
  $flags = 0x0010 -bor 0x0020
  if (-not $gated) { $flags = $flags -bor 0x0040 }
  $ok = [Moyu.Win]::SetWindowPos($handle, $after, $px, $py, $pw, $ph, $flags)
  if ($gated) { [void][Moyu.Win]::ShowWindow($handle, 0) }
  $r = Get-Rect $handle
  return @{ ok = [bool]$ok; x = $r.x; y = $r.y; w = $r.w; h = $r.h; gated = $gated }
}

# Tuck the bound window into its rect AND hide every other visible window of the
# engine process tree. "Other" windows are: the stale mirror window the engine
# keeps alive after a disconnect (it holds the last frame forever), the Qt tray
# message window (stretched to the video size, parked at the bottom-right of the
# screen), and any freshly created video window that has not been bound yet.
function Invoke-Tuck([long]$targetHwnd, [int]$px, [int]$py, [int]$pw, [int]$ph, [long]$epoch) {
  # A tuck queued before the float was hidden must never re-show anything.
  if ($script:engineGate -eq 0) {
    [void](Hide-Engine-Windows -1)
    return @{ ok = $false; gated = $true }
  }
  if ($epoch -ge 0) {
    # A freshly spawned host starts at epoch 0. Adopt the first epoch we see
    # instead of rejecting every tuck as stale (the parent also writes a gate
    # line on startup; this is the belt-and-braces fallback).
    if ($script:engineEpoch -eq 0) { $script:engineEpoch = $epoch }
    elseif ($epoch -ne $script:engineEpoch) { return @{ ok = $false; stale = $true } }
  }
  $handle = [IntPtr]::new($targetHwnd)
  if ($handle -eq [IntPtr]::Zero) { return @{ ok = $false; error = 'bad hwnd' } }
  $rows = @(Get-Rows)
  $cur = $null
  foreach ($row in $rows) { if ([long]$row.hwnd -eq $targetHwnd) { $cur = $row; break } }
  if ($null -eq $cur) { return @{ ok = $false; error = 'window gone' } }
  $placed = @{ ok = $true; x = [int]$cur.x; y = [int]$cur.y; w = [int]$cur.w; h = [int]$cur.h }
  # Only move when it actually drifted: the guard runs every ~1.2s and the drag
  # follower fires even more often, and an unconditional SetWindowPos would fight
  # the engine's own resizes (phone rotation) frame by frame.
  $drift = 0
  foreach ($delta in @(
      [Math]::Abs([int]$cur.x - $px), [Math]::Abs([int]$cur.y - $py),
      [Math]::Abs([int]$cur.w - $pw), [Math]::Abs([int]$cur.h - $ph))) {
    if ($delta -gt $drift) { $drift = $delta }
  }
  if (-not $cur.visible -or $cur.iconic -or $drift -gt 6) {
    $placed = Invoke-Place $handle $px $py $pw $ph 'bottom'
  }
  $placed.hidden = @(Hide-Engine-Windows $targetHwnd)
  return $placed
}

function Invoke-Vis([long]$targetHwnd, [int]$show) {
  $handle = [IntPtr]::new($targetHwnd)
  if ($handle -eq [IntPtr]::Zero) { return @{ ok = $false; error = 'bad hwnd' } }
  # SW_SHOWNOACTIVATE=4 keeps the user's focus where it is, SW_HIDE=0
  $cmd = 0
  if ($show -eq 1) { $cmd = 4 }
  [void][Moyu.Win]::ShowWindow($handle, $cmd)
  $script:engineGate = $show
  # Hiding the float must hide EVERY engine window. Hiding only the bound
  # video window leaves the Qt tray message window / stale mirror window on
  # the desktop, which is what users report as "uxplay still shows up".
  # Showing it back keeps only the bound window visible.
  $hidden = @(Hide-Engine-Windows $targetHwnd)
  return @{
    ok = $true
    visible = [bool][Moyu.Win]::IsWindowVisible($handle)
    hidden = $hidden
  }
}

if ($Action -eq 'list') {
  ConvertTo-Json -InputObject @(Get-Rows) -Compress -Depth 4
  exit 0
}

if ($Action -eq 'place') {
  $handle = [IntPtr]::new($Target)
  if ($handle -eq [IntPtr]::Zero) { Write-Output '{"ok":false,"error":"bad hwnd"}'; exit 1 }
  ConvertTo-Json -Compress -InputObject (Invoke-Place $handle $X $Y $W $H $Layer) -Depth 4
  exit 0
}

if ($Action -eq 'tuck') {
  ConvertTo-Json -Compress -InputObject (Invoke-Tuck $Target $X $Y $W $H $Epoch) -Depth 4
  exit 0
}

if ($Action -eq 'gate') {
  ConvertTo-Json -Compress -InputObject (Invoke-Gate $Epoch $Show) -Depth 4
  exit 0
}

if ($Action -eq 'visibility') {
  # Show (1) / hide (0) the engine window. Used when the float window is hidden:
  # the video window sits right behind it, so leaving it visible would put the whole
  # mirrored phone screen on the user's desktop.
  ConvertTo-Json -Compress -InputObject (Invoke-Vis $Target $Show) -Depth 4
  exit 0
}

if ($Action -eq 'server') {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }     # stdin closed -> parent is gone -> exit
    $line = $line.Trim()
    if ($line -eq '') { continue }
    $parts = $line -split ' '
    $res = $null
    try {
      switch ($parts[0]) {
        'list' {
          $res = ConvertTo-Json -InputObject @(Get-Rows) -Compress -Depth 4
        }
        'place' {
          $res = ConvertTo-Json -Compress -InputObject (Invoke-Place ([IntPtr]::new([long]$parts[1])) ([int]$parts[2]) ([int]$parts[3]) ([int]$parts[4]) ([int]$parts[5]) ([string]$parts[6])) -Depth 4
        }
        'tuck' {
          $ep = -1
          if ($parts.Count -ge 7) { $ep = [long]$parts[6] }
          $res = ConvertTo-Json -Compress -InputObject (Invoke-Tuck ([long]$parts[1]) ([int]$parts[2]) ([int]$parts[3]) ([int]$parts[4]) ([int]$parts[5]) $ep) -Depth 4
        }
        'vis' {
          $res = ConvertTo-Json -Compress -InputObject (Invoke-Vis ([long]$parts[1]) ([int]$parts[2])) -Depth 4
        }
        'gate' {
          $res = ConvertTo-Json -Compress -InputObject (Invoke-Gate ([long]$parts[1]) ([int]$parts[2])) -Depth 4
        }
        default {
          $res = '{"ok":false,"error":"unknown cmd"}'
        }
      }
    } catch {
      $res = '{"ok":false,"error":"cmd failed"}'
    }
    [Console]::Out.WriteLine($res)
    [Console]::Out.Flush()
  }
  exit 0
}

Write-Output '{"ok":false,"error":"unknown action"}'
exit 1
