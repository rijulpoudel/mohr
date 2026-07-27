import express from "express";
import authRoutes from "./routes/auth.js";
import jwtAuth from "./middleware/jwtAuth.js";

const app = express();
const PORT = 3001;

app.use(express.json());

// First go to Public Routes (no token need) to get a token
app.use("/auth", authRoutes);

// Then go to Protected Routes (JWT token check first)
app.get("/", (req, res) => {
  res.json({ message: "Mohr API is running" });
});

app.listen(PORT, () => {
  console.log(`Started listening on Port ${PORT}`);
});
