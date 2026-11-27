#requires -version 5.1
<#
  Diagnostic: can this machine raise a Windows Action Center toast WITH
  Approve/Deny buttons, using only built-in WinRT (no external modules)?
#>

Write-Output "=== environment ==="
Write-Output "PSVersion: $($PSVersionTable.PSVersion)"
[System.Environment]::OSVersion.VersionString

# --- Await helper for WinRT IAsyncOperation in PS 5.1 -----------------------
function Await($WinRtTask, $ResultType) {
    $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
    $netTask = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

Write-Output "=== 1. WinRT toast types resolvable? ==="
try {
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
    $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime]
    Write-Output "OK   WinRT notification types resolve"
} catch {
    Write-Output "FAIL WinRT types: $($_.Exception.Message)"
    exit 1
}

# --- Register an AppUserModelID (required to raise a toast from a script) ---
$appId = 'Krisha.Toast.Test'
Write-Output "=== 2. register AUMID ==="
try {
    $key = "HKCU:\Software\Classes\AppUserModelId\$appId"
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    New-ItemProperty -Path $key -Name 'DisplayName' -Value 'Krisha' -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $key -Name 'IconUri' -Value '' -PropertyType String -Force | Out-Null
    Write-Output "OK   AUMID registered at $key"
} catch {
    Write-Output "FAIL AUMID: $($_.Exception.Message)"
}

# --- Register a protocol handler for the toast buttons ----------------------
Write-Output "=== 3. register krisha:// protocol ==="
try {
    $proto = 'HKCU:\Software\Classes\krisha'
    if (-not (Test-Path $proto)) { New-Item -Path $proto -Force | Out-Null }
    New-ItemProperty -Path $proto -Name '(Default)' -Value 'URL:Krisha Protocol' -PropertyType String -Force | Out-Null
    $cmd = Join-Path $proto 'shell\open\command'
    if (-not (Test-Path $cmd)) { New-Item -Path $cmd -Force | Out-Null }
    New-ItemProperty -Path $cmd -Name '(Default)' -Value 'notepad.exe "%1"' -PropertyType String -Force | Out-Null
    Write-Output "OK   krisha:// registered (handler = notepad for the test)"
} catch {
    Write-Output "FAIL protocol: $($_.Exception.Message)"
}

# --- Raise the toast -------------------------------------------------------
Write-Output "=== 4. raise the toast ==="
try {
    $xml = @"
<toast activationType="foreground" duration="long">
  <visual>
    <binding template="ToastGeneric">
      <text>Krisha needs your approval</text>
      <text>Allow launching suspicious.exe?</text>
    </binding>
  </visual>
  <actions>
    <action content="Approve" activationType="protocol" arguments="krisha://approval?id=test1&amp;decision=approve" />
    <action content="Deny" activationType="protocol" arguments="krisha://approval?id=test1&amp;decision=deny" />
  </actions>
</toast>
"@
    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $doc.LoadXml($xml)
    $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
    $notifier.Show($toast)
    Write-Output "OK   toast raised (check the Action Center)"
} catch {
    Write-Output "FAIL toast: $($_.Exception.Message)"
    Write-Output $_.Exception.GetType().FullName
}

Write-Output "=== done ==="
