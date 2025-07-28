export const normalizeToLowercase = (str = "") =>
  str
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
