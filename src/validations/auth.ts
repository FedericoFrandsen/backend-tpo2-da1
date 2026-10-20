export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;

export function validarPassword(password: string): string {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return "La contraseña debe tener al menos 8 caracteres.";
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return "La contraseña no puede superar los 72 caracteres.";
  }
  const tieneLetras = /[A-Za-z]/.test(password);
  const tieneNumeros = /\d/.test(password);
  if (!tieneLetras || !tieneNumeros) {
    return "La contraseña debe incluir letras y números.";
  }
  return "";
}
