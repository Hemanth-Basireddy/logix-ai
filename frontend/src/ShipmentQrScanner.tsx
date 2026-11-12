import { useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader, type IScannerControls } from "@zxing/browser";
import { shipmentQrPrefix } from "./ShipmentQrCode";

export function ShipmentQrScanner({ onResolve }: { onResolve: (consignmentNo: string) => Promise<void> }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const generationRef = useRef(0);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => () => {
    generationRef.current += 1;
    controlsRef.current?.stop();
    const stream = videoRef.current?.srcObject;
    if (stream instanceof MediaStream) stream.getTracks().forEach((track) => track.stop());
  }, []);

  function stopCamera() {
    generationRef.current += 1;
    controlsRef.current?.stop();
    controlsRef.current = null;
    const stream = videoRef.current?.srcObject;
    if (stream instanceof MediaStream) stream.getTracks().forEach((track) => track.stop());
    setScanning(false);
  }

  async function startCamera() {
    setError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Camera access is unavailable. Enter the consignment number in the verification field below.");
      return;
    }

    const generation = ++generationRef.current;
    setScanning(true);
    try {
      const reader = new BrowserQRCodeReader();
      const controls = await reader.decodeFromConstraints(
        { video: { facingMode: { ideal: "environment" } }, audio: false },
        videoRef.current ?? undefined,
        (result, _decodeError, activeControls) => {
          if (!result || generation !== generationRef.current) return;
          activeControls.stop();
          controlsRef.current = null;
          setScanning(false);
          const value = result.getText();
          const consignmentNo = value.startsWith(shipmentQrPrefix) ? value.slice(shipmentQrPrefix.length) : "";
          if (!/^[A-Za-z0-9-]{1,50}$/.test(consignmentNo)) {
            setError("This QR code is not a Logix shipment code.");
            return;
          }
          void onResolve(consignmentNo).catch((caught: unknown) => {
            setError(caught instanceof Error ? caught.message : "This shipment QR could not be authorized.");
          });
        },
      );
      if (generation !== generationRef.current) controls.stop();
      else controlsRef.current = controls;
    } catch (caught) {
      if (generation === generationRef.current) {
        setScanning(false);
        setError(caught instanceof Error ? caught.message : "Camera access failed. Enter the consignment number manually.");
      }
    }
  }

  return <div className="shipment-qr-scanner">
    {!scanning ? <button className="op-button" onClick={() => void startCamera()} type="button">Scan shipment QR</button> : <button className="op-button" onClick={stopCamera} type="button">Stop camera</button>}
    <video ref={videoRef} className="shipment-qr-camera" aria-label="Shipment QR camera preview" hidden={!scanning} muted playsInline />
    <small>QR contains only the official consignment number. Manual consignment entry remains available below.</small>
    {error && <p className="op-error" role="alert">{error}</p>}
  </div>;
}
