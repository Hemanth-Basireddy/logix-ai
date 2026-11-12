import { useEffect, useState } from "react";

export const shipmentQrPrefix = "LOGIX-SHIPMENT:";
export function shipmentQrPayload(consignmentNo: string) { return `${shipmentQrPrefix}${consignmentNo}`; }

export function ShipmentQrCode({ consignmentNo }: { consignmentNo: string }) {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setImage(null);
    void import("qrcode").then(({ default: QRCode }) => QRCode.toDataURL(shipmentQrPayload(consignmentNo), { errorCorrectionLevel: "M", margin: 2, width: 180 }))
      .then((data) => { if (active) setImage(data); })
      .catch(() => { if (active) setImage(null); });
    return () => { active = false; };
  }, [consignmentNo]);
  return <div className="shipment-qr" aria-label={`QR code for shipment ${consignmentNo}`}>
    {image ? <img src={image} alt={`Shipment QR code for ${consignmentNo}`} width={180} height={180} /> : <span>Preparing shipment QR…</span>}
    <code>{consignmentNo}</code>
  </div>;
}
