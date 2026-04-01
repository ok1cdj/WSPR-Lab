import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// API Route for WSPR query
app.post("/api/wspr", async (req, res) => {
  const { call1, call2, band, hours } = req.body;

    // Construct SQL query for wspr.live
    const transmitters = [call1, call2].filter(Boolean).map(c => `'${c}'`).join(',');
    
    // Ensure band is treated as a number in the query
    const bandNum = parseInt(band);
    
    const sql = `
      SELECT 
          time as datetime, tx_sign as transmitter, rx_sign as reporter, snr, power,
          tx_lat, tx_lon, rx_lat, rx_lon, azimuth
      FROM wspr.rx
      WHERE tx_sign IN (${transmitters})
        AND band = ${bandNum}
        AND time > now() - INTERVAL ${hours} HOUR
      ORDER BY time DESC
      LIMIT 5000
      FORMAT JSON
    `;

    console.log("WSPR Query SQL:", sql.trim());

    try {
      const url = new URL("https://db1.wspr.live/");
      url.searchParams.append("query", sql.trim());

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "User-Agent": "WSPR-Antenna-Lab/1.0",
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("WSPR API Error Response:", errorText);
        throw new Error(`WSPR API Error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      res.json(data);
    } catch (error: any) {
      console.error("WSPR Query Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

// API Route to find nearby stations
app.post("/api/nearby", async (req, res) => {
  const { callA, band } = req.body;
    const bandNum = parseInt(band);

    if (!callA || isNaN(bandNum)) {
      return res.status(400).json({ error: "Invalid parameters" });
    }

    try {
      // 1. Get location of callA (most recent, within last 7 days)
      const locSql = `
        SELECT tx_lat, tx_lon 
        FROM wspr.rx 
        WHERE tx_sign = '${callA}' 
          AND time > now() - INTERVAL 7 DAY
          AND tx_lat != 0 
          AND tx_lon != 0
        ORDER BY time DESC
        LIMIT 1 
        FORMAT JSON
      `;
      
      const locUrl = new URL("https://db1.wspr.live/");
      locUrl.searchParams.append("query", locSql.trim());
      const locRes = await fetch(locUrl.toString(), { 
        headers: { "User-Agent": "WSPR-Antenna-Lab/1.0" },
        signal: AbortSignal.timeout(10000)
      });
      
      if (!locRes.ok) {
        const errText = await locRes.text();
        console.error("Location Query Error:", errText);
        return res.status(locRes.status).json({ error: "WSPR API Error fetching location" });
      }

      const locData = await locRes.json();

      if (!locData.data || locData.data.length === 0) {
        return res.json({ stations: [] });
      }

      const { tx_lat: latA, tx_lon: lonA } = locData.data[0];

      if (latA === undefined || lonA === undefined) {
        return res.json({ stations: [] });
      }

      // 2. Find nearby transmitters on the same band
      // Use geoDistance for better performance in ClickHouse
      const nearbySql = `
        SELECT tx_sign, 
               min(geoDistance(tx_lon, tx_lat, ${lonA}, ${latA})) as distance,
               max(power) as power
        FROM wspr.rx
        WHERE band = ${bandNum}
          AND time > now() - INTERVAL 4 HOUR
          AND tx_sign != '${callA}'
          AND tx_lat != 0
          AND tx_lon != 0
        GROUP BY tx_sign
        ORDER BY distance ASC
        LIMIT 30
        FORMAT JSON
      `;

      const nearbyUrl = new URL("https://db1.wspr.live/");
      nearbyUrl.searchParams.append("query", nearbySql.trim());
      const nearbyRes = await fetch(nearbyUrl.toString(), { 
        headers: { "User-Agent": "WSPR-Antenna-Lab/1.0" },
        signal: AbortSignal.timeout(30000)
      });

      if (!nearbyRes.ok) {
        const errText = await nearbyRes.text();
        console.error("Nearby Query Error:", errText);
        return res.status(nearbyRes.status).json({ error: "WSPR API Error fetching nearby stations" });
      }

      const nearbyData = await nearbyRes.json();

      res.json({ stations: nearbyData.data || [] });
    } catch (error: any) {
      console.error("Nearby Query Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", env: process.env.NODE_ENV, vercel: !!process.env.VERCEL });
});

async function startServer() {
  const PORT = 3000;

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production" && !process.env.VERCEL) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else if (!process.env.VERCEL) {
    // Persistent server (Cloud Run) serving static files
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  if (!process.env.VERCEL) {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  }
}

startServer();

export default app;
