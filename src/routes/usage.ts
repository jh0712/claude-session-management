import { Router } from "express";
import { getDailyUsage } from "../services/sessionParser";

const router = Router();

// GET /api/usage?date=2026-04-02 (defaults to today)
router.get("/", (req, res) => {
  const date = req.query.date as string | undefined;
  res.json(getDailyUsage(date || undefined));
});

export default router;
