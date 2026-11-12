export type CompanyBranding = {
  logoPath?: string;
  accentColor?: string;
};

export function mergeCompanyBranding(
  defaults: Record<string, CompanyBranding>,
  overrides: Record<string, CompanyBranding>,
): Record<string, CompanyBranding> {
  const merged: Record<string, CompanyBranding> = { ...defaults };

  for (const [companyId, branding] of Object.entries(overrides)) {
    merged[companyId] = { ...merged[companyId], ...branding };
  }

  return merged;
}
