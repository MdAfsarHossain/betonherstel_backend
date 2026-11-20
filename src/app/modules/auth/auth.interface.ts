export interface IUserLogin {
  email: string;
  password: string;
  fcm_token?: string;
}

export interface IChangePassword {
  newPassword: string;
  oldPassword: string;
}

export interface IResetPassword {
  token: string;
  newPassword: string;
}

// Result of login / 2FA verification once the user is fully signed in
export interface ISession {
  id: string;
  name: string;
  email: string;
  phone_number: string | null;
  address: string | null;
  date_of_birth: string | null;
  role: string;
  avatar: string | null;
  status: string;
  preferred_language: string;
  accessToken: string;
  refreshToken: string;
}
