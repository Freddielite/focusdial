import { asyncRouter } from "../lib/asyncRouter.js";
import { pool } from "../db.js";

export const qualityModelRouter = asyncRouter();

// Read-only by design - the model is only ever written by
// routes/cron.js's weekly retrain (see checkQualityModelTraining).
// Returns null (not a 404) when nothing has trained yet - that's the
// normal, expected state for a new account or one without enough
// labeled sessions yet, not an error. priorityEngine.js's
// predictedQualityScore already treats null the same way
// qualityModel.js's own predictQuality does: no prediction, fall back
// to the existing energy-fit heuristic alone.
qualityModelRouter.get("/quality-model", async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT model, trained_at FROM quality_models WHERE user_id = $1`, [
      req.userId,
    ]);
    if (!rows.length) return res.json({ model: null, trainedAt: null });
    res.json({ model: rows[0].model, trainedAt: rows[0].trained_at });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load quality model" });
  }
});
