export const minimumPasswordLength = 12;
export const maximumPasswordLength = 1024;

export function isValidResetPassword(value: string): boolean {
  return value.length >= minimumPasswordLength && value.length <= maximumPasswordLength;
}
