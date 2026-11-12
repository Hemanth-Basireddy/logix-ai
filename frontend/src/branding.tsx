import type { CSSProperties } from "react";
import type { Employee } from "./types";

type TenantStyle = CSSProperties & {
  "--tenant-accent"?: string;
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export function CompanyBrand({ employee }: { employee: Employee }) {
  const branding = employee.company.branding;
  const style: TenantStyle = branding.accentColor
    ? { "--tenant-accent": branding.accentColor }
    : {};

  return (
    <div className="company-brand" style={style}>
      {branding.logoPath ? (
        <img alt="" className="company-logo" src={branding.logoPath} />
      ) : (
        <span aria-hidden="true" className="company-monogram">
          {initials(employee.company.name)}
        </span>
      )}
      <span className="company-brand-name">{employee.company.name}</span>
    </div>
  );
}
