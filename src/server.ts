import express from "express";
import { join } from "path";
import sessionsRouter from "./routes/sessions";

const app = express();
const PORT = process.env.PORT || 3456;

app.use(express.json());
app.use(express.static(join(import.meta.dir, "public")));

app.use("/api/sessions", sessionsRouter);

app.listen(PORT, () => {
  console.log(`Session Manager running at http://localhost:${PORT}`);
});
