/** Remove formatting only. Preserve every digit: country codes and leading zeroes
 * are never inferred or discarded during identity matching. */
export function customerPhoneKey(value: string): string {
  return value.replace(/\D/g, "");
}

export function toOtpE164(
  storedPhone: string,
  defaultCountryCode: string,
): string | null {
  const digits = customerPhoneKey(storedPhone);
  if (!digits || digits.length > 15) return null;
  if (storedPhone.trim().startsWith("+")) return digits.length >= 8 && !digits.startsWith("0") ? `+${digits}` : null;
  if (!defaultCountryCode) return null;
  const countryDigits = customerPhoneKey(defaultCountryCode);
  // Unprefixed values are treated as national-format only when the deployment
  // explicitly configures its default calling code. International values must
  // include '+' so the provider destination is never guessed from digit length.
  const internationalDigits = `${countryDigits}${digits}`;
  if (internationalDigits.length < 8 || internationalDigits.length > 15 || internationalDigits.startsWith("0")) return null;
  return `+${internationalDigits}`;
}
