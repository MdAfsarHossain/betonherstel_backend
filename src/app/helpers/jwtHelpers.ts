import jwt, { JwtPayload, Secret } from "jsonwebtoken";

const generateToken = (
  payload: Record<string, unknown>,
  secret: Secret,
  expiresIn: any,
): string => {
  const token = jwt.sign(payload, secret, {
    algorithm: "HS256",
    expiresIn,
  });
  return token;
};

const verifyToken = (token: string, secret: Secret) => {
  // Only HS256 is accepted: never the algorithm the token's own header asks for
  return jwt.verify(token, secret, { algorithms: ["HS256"] }) as JwtPayload;
};

export const jwtHelpers = {
  generateToken,
  verifyToken,
};
