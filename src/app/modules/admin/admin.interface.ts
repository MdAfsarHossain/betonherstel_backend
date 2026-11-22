import { TLanguage } from "../user/user.interface";

// Roles an admin may assign to internal (staff) users
export type TInternalRole = "ADMIN" | "OFFICE" | "FIELD";

export type TUserStatus = "ACTIVE" | "INACTIVE" | "BLOCKED";

// Admin (Beheerder) creating an internal user
export interface ICreateUser {
  name: string;
  email: string;
  password: string;
  phone_number?: string;
  role: TInternalRole;
  preferred_language?: TLanguage;
}

// Admin (Beheerder) editing another user
export interface IAdminUpdateUser {
  name?: string;
  phone_number?: string;
  address?: string;
  role?: TInternalRole;
  status?: TUserStatus;
  is_active?: boolean;
  preferred_language?: TLanguage;
}
