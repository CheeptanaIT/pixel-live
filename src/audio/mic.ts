export interface MicDevice {
  deviceId: string;
  label: string;
}

export type MicErrorKind = "denied" | "notFound" | "busy" | "unknown";

export class MicError extends Error {
  constructor(readonly kind: MicErrorKind) {
    super(kind);
  }
}

export async function openMic(deviceId?: string): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") throw new MicError("denied");
    if (name === "NotFoundError" || name === "OverconstrainedError") throw new MicError("notFound");
    if (name === "NotReadableError" || name === "AbortError") throw new MicError("busy");
    throw new MicError("unknown");
  }
}

/** Labels are only filled in once the user has granted mic permission. */
export async function listMics(): Promise<MicDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === "audioinput" && d.deviceId)
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `ไมค์ ${i + 1}` }));
}

export function stopStream(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((t) => t.stop());
}

export function currentDeviceId(stream: MediaStream | null): string | undefined {
  return stream?.getAudioTracks()[0]?.getSettings().deviceId;
}
