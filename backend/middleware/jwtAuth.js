import jwt from "jsonwebtoken";

const JWT_SECRET = "***";

export default (req, res, next) => {
  const header = req.headers["authorization"];

  if (!header) return res.status(401).json({ error: "No token provided" });

  const token = header.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (e) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
};
