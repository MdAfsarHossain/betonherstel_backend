export type TLanguage = "NL" | "EN";

// Fields a user may change on their own profile
export interface IUpdateProfile {
  name?: string;
  phone_number?: string;
  email?: string;
  address?: string;
  date_of_birth?: string;
  preferred_language?: TLanguage;
}
