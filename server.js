
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;
const API_URL = "https://api.football-data.org/v4";
const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const COMPETITIONS = process.env.COMPETITIONS || "WC,CL,BL1,DED";

const cache = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

async function footballAPI(endpoint) {
  if (!TOKEN) throw new Error("Football API token is missing.");

  const response = await fetch(API_URL + endpoint, {
    headers: { "X-Auth-Token": TOKEN }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.message || "Football API error: " + response.status);
  }

  return data;
}

async function cached(key, endpoint, ttl = 300000) {
  const old = cache.get(key);

  if (old && Date.now() - old.time < ttl) return old.data;

  const data = await footballAPI(endpoint);
  cache.set(key, { time: Date.now(), data });
  return data;
}

function getDate(date) {
  return date.toISOString().slice(0, 10);
}

function getStats(matches, teamId) {
  const games = (matches || [])
    .filter(m =>
      m.status === "FINISHED" &&
      m.score?.fullTime?.home !== null &&
      m.score?.fullTime?.away !== null &&
      m.score?.fullTime?.home !== undefined &&
      m.score?.fullTime?.away !== undefined
    )
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
    .slice(0, 5);

  let wins = 0, draws = 0, losses = 0;
  let scored = 0, conceded = 0;

  const form = games.reverse().map(m => {
    const home = m.homeTeam.id === teamId;
    const gf = home ? m.score.fullTime.home : m.score.fullTime.away;
    const ga = home ? m.score.fullTime.away : m.score.fullTime.home;

    scored += gf;
    conceded += ga;

    if (gf > ga) {
      wins++;
      return "W";
    }

    if (gf === ga) {
      draws++;
      return "D";
    }

    losses++;
    return "L";
  });

  return {
    played: games.length,
    wins, draws, losses,
    scored, conceded,
    points: wins * 3 + draws,
    form
  };
}

function probabilities(home, away, h2h) {
  const score = s => s.played ? s.points / (s.played * 3) : 0.5;

  let difference =
    (score(home) - score(away)) * 0.65 + 0.07 * 0.35;

  if (h2h.played) {
    difference = difference * 0.75 +
      ((h2h.homeWins - h2h.awayWins) / h2h.played) * 0.25;
  }

  difference = Math.max(-0.65, Math.min(0.65, difference));

  const draw = 0.27 - Math.abs(difference) * 0.10;
  const homeWin = (1 - draw) / 2 + difference / 2;
  const awayWin = (1 - draw) / 2 - difference / 2;
  const total = homeWin + draw + awayWin;

  return {
    homeWin: Math.round(homeWin / total * 100),
    draw: Math.round(draw / total * 100),
    awayWin: Math.round(awayWin / total * 100)
  };
}

// API health check
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "BISTOWELHUB API is running",
    connected: Boolean(TOKEN)
  });
});

// Automatically load upcoming matches
app.get("/api/matches", async (req, res) => {
  try {
    const today = new Date();
    const end = new Date(today);
    end.setDate(end.getDate() + 10);

    const endpoint =
      `/matches?competitions=${encodeURIComponent(COMPETITIONS)}` +
      `&dateFrom=${getDate(today)}&dateTo=${getDate(end)}`;

    const data = await cached("upcoming", endpoint);

    const matches = (data.matches || [])
      .filter(m =>
        ["SCHEDULED", "TIMED", "IN_PLAY", "PAUSED"].includes(m.status)
      )
      .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

    res.json({
      success: true,
      count: matches.length,
      matches
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Analyse an individual match
app.get("/api/analyze/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid match ID"
      });
    }

    const matchData = await cached(`match-${id}`, `/matches/${id}`);
    const match = matchData.match || matchData;

    const homeId = match.homeTeam.id;
    const awayId = match.awayTeam.id;

    const from = new Date();
    from.setDate(from.getDate() - 365);

    const fromDate = getDate(from);
    const toDate = getDate(new Date());

    const [homeData, awayData, h2hData] = await Promise.all([
      cached(`home-${homeId}`,
        `/teams/${homeId}/matches?dateFrom=${fromDate}&dateTo=${toDate}&limit=20`,
        600000),
      cached(`away-${awayId}`,
        `/teams/${awayId}/matches?dateFrom=${fromDate}&dateTo=${toDate}&limit=20`,
        600000),
      cached(`h2h-${id}`,
        `/matches/${id}/head2head?limit=10`,
        600000).catch(() => ({}))
    ]);

    const homeStats = getStats(homeData.matches, homeId);
    const awayStats = getStats(awayData.matches, awayId);

    const h2hMatches = h2hData.head2head?.matches ||
      h2hData.matches || [];

    let homeWins = 0, awayWins = 0, draws = 0, totalGoals = 0;

    h2hMatches.forEach(m => {
      if (
        m.status !== "FINISHED" ||
        m.score?.fullTime?.home == null ||
        m.score?.fullTime?.away == null
      ) return;

      const hg = m.homeTeam.id === homeId
        ? m.score.fullTime.home : m.score.fullTime.away;

      const ag = m.homeTeam.id === awayId
        ? m.score.fullTime.home : m.score.fullTime.away;

      totalGoals += hg + ag;

      if (hg > ag) homeWins++;
      else if (hg < ag) awayWins++;
      else draws++;
    });

    const played = homeWins + awayWins + draws;

    const h2h = {
      played, homeWins, awayWins, draws,
      averageGoals: played
        ? (totalGoals / played).toFixed(2)
        : null
    };

    const p = probabilities(homeStats, awayStats, h2h);

    const homeAvg = homeStats.played
      ? homeStats.scored / homeStats.played : 0;

    const awayAvg = awayStats.played
      ? awayStats.scored / awayStats.played : 0;

    const averageGoals = (homeAvg + awayAvg) / 2;

    const markets = [
      {
        name: "Over 1.5 Goals",
        probability: Math.min(95, Math.round(55 + averageGoals * 12))
      },
      {
        name: "Over 2.5 Goals",
        probability: Math.min(90, Math.max(15,
          Math.round(25 + averageGoals * 15)))
      },
      {
        name: "Under 3.5 Goals",
        probability: Math.max(10, Math.min(95,
          Math.round(95 - averageGoals * 15)))
      }
    ].sort((a, b) => b.probability - a.probability);

    const outcomes = [
      { name: "Home Win", probability: p.homeWin },
      { name: "Draw", probability: p.draw },
      { name: "Away Win", probability: p.awayWin }
    ].sort((a, b) => b.probability - a.probability);

    res.json({
      success: true,
      match: {
        id,
        homeTeam: match.homeTeam.name,
        awayTeam: match.awayTeam.name
      },
      analysis: {
        homeStats,
        awayStats,
        h2h,
        probabilities: p,
        averageGoals: averageGoals.toFixed(2),
        prediction: outcomes[0],
        confidence: outcomes[0].probability,
        bestMarket: markets[0],
        markets
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log("BISTOWELHUB running on port " + PORT);
});

