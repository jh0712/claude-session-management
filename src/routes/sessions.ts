import { Router } from "express";
import { getAllSessions, getSessionById, searchSessions } from "../services/sessionParser";

const router = Router();

// GET /api/sessions?q=keyword - search, or list all
router.get("/", (req, res) => {
  const q = req.query.q as string | undefined;
  if (q && q.trim()) {
    res.json(searchSessions(q.trim()));
  } else {
    res.json(getAllSessions());
  }
});

// GET /api/sessions/:id - get session detail
router.get("/:id", (req, res) => {
  const session = getSessionById(req.params.id);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json(session);
});

export default router;
