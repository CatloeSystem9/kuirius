/**
 * Windows audio peak-meter probe (Step 2 verification support).
 *
 * Reads IAudioMeterInformation from the DEFAULT RENDER DEVICE (the laptop's
 * actual output endpoint) via a temporary PowerShell/.NET inline component.
 * A device-level peak > 0 proves audio is ACTUALLY rendered through the
 * laptop output — the honest "audible" check, not just "play() resolved".
 *
 * Attribution method: sample a silence baseline first, then sample while
 * Krix speaks — the delta is Krix's audio (nothing else should be playing).
 *
 * Usage: npx tsx scripts/real-machine-check-audio-peak.ts [samples] [intervalMs]
 */
import { execFileSync } from 'node:child_process';

const psScript = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class DevicePeakProbe {
    [ComImport, Guid("87CE5494-4D7C-4B46-84F9-CA04E9F0ADFF"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioMeterInformation {
        float GetPeakValue();
    }
    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}

    public static double Probe() {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice device;
        enumerator.GetDefaultAudioEndpoint(0 /*eRender*/, 0 /*eConsole*/, out device);
        var iid = new Guid("87CE5494-4D7C-4B46-84F9-CA04E9F0ADFF");
        object meterObj;
        device.Activate(ref iid, 1 /*CLSCTX_ALL*/, IntPtr.Zero, out meterObj);
        var meter = (IAudioMeterInformation)meterObj;
        return meter.GetPeakValue();
    }
}
"@
try {
    [DevicePeakProbe]::Probe().ToString("F4", [System.Globalization.CultureInfo]::InvariantCulture)
} catch {
    Write-Output ("ERROR:" + $_.Exception.Message)
}
`;

const samples = Number(process.argv[2] ?? 8);
const intervalMs = Number(process.argv[3] ?? 400);

function probe(): number {
  const out = execFileSync('powershell', ['-NoProfile', '-Command', psScript], { encoding: 'utf8', timeout: 20_000 }).trim();
  if (out.startsWith('ERROR:')) throw new Error(out.slice(6));
  const v = parseFloat(out);
  if (Number.isNaN(v)) throw new Error(`unparseable probe output: ${out}`);
  return v;
}

console.log(`[peak-probe] sampling the default render device: ${samples} samples / ${intervalMs}ms`);
let maxPeak = 0;
for (let i = 0; i < samples; i++) {
  const peak = probe();
  maxPeak = Math.max(maxPeak, peak);
  console.log(`[peak-probe] sample ${i + 1}/${samples}: devicePeak=${peak.toFixed(4)}`);
  if (i < samples - 1) execFileSync('powershell', ['-NoProfile', '-Command', `Start-Sleep -Milliseconds ${intervalMs}`], { timeout: 15_000 });
}
console.log(`[peak-probe] RESULT maxDevicePeak=${maxPeak.toFixed(4)} (0 = silence at the output; >0 = audio actually rendered through the laptop output)`);
process.exit(0);
