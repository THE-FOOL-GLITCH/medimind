// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

/* ================== PATH BASICS ================== */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

/* ================== CONFIG ================== */

const OLLAMA_URL = "http://127.0.0.1:11434/api/chat";
const OLLAMA_MODEL = "mistral";

// Supabase admin client (server-side only)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ================== MIDDLEWARE ================== */

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ================== FILE UPLOAD (NO OCR YET) ================== */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

/* ================== ROUTES ================== */

// Serve frontend HTML
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "medimind.html"));
});

/* ================== OLLAMA CALL ================== */

async function callOllama(messages) {
  const response = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      stream: false
    })
  });

  if (!response.ok) {
    const txt = await response.text();
    throw new Error(txt);
  }

  const data = await response.json();
  return data.message.content;
}

/* ================== PARSE AGENT RESPONSE ================== */

function parseAgentResponse(response) {
  const agents = {
    symptom: "",
    risk: "",
    fraud: "",
    security: "",
    coordinator: "",
    recommendations: ""
  };

  const sections = {
    symptom:
      /🔍\s*SYMPTOM_ANALYZER:?\s*([\s\S]*?)(?=📊|RISK_PREDICTOR|🛡️|FRAUD_DETECTOR|🔐|SECURITY_GUARDIAN|🤖|COORDINATOR|💊|RECOMMENDATIONS|$)/i,
    risk:
      /📊\s*RISK_PREDICTOR:?\s*([\s\S]*?)(?=🛡️|FRAUD_DETECTOR|🔐|SECURITY_GUARDIAN|🤖|COORDINATOR|💊|RECOMMENDATIONS|$)/i,
    fraud:
      /🛡️\s*FRAUD_DETECTOR:?\s*([\s\S]*?)(?=🔐|SECURITY_GUARDIAN|🤖|COORDINATOR|💊|RECOMMENDATIONS|$)/i,
    security:
      /🔐\s*SECURITY_GUARDIAN:?\s*([\s\S]*?)(?=🤖|COORDINATOR|💊|RECOMMENDATIONS|$)/i,
    coordinator:
      /🤖\s*COORDINATOR_INSIGHTS:?\s*([\s\S]*?)(?=💊|RECOMMENDATIONS|$)/i,
    recommendations: /💊\s*RECOMMENDATIONS:?\s*([\s\S]*?)$/i
  };

  Object.keys(sections).forEach((key) => {
    const match = response.match(sections[key]);
    if (match && match[1]) {
      agents[key] = match[1].trim();
    }
  });

  return agents;
}

/* ================== ANALYZE ================== */

app.post("/api/analyze", upload.single("prescription"), async (req, res) => {
  try {
    const { symptoms, age, history, name, userCode } = req.body;

    if (!symptoms || !age) {
      return res.status(400).json({ error: "Missing symptoms or age" });
    }

    const systemPrompt = `
You are MediMind, a SINGLE LLM acting as SIX agents:

🔍 SYMPTOM_ANALYZER
📊 RISK_PREDICTOR
🛡️ FRAUD_DETECTOR
🔐 SECURITY_GUARDIAN
🤖 COORDINATOR_INSIGHTS
💊 RECOMMENDATIONS

Rules:
- NO doctor / hospital / clinic suggestions
- NO medication or prescriptions
- Only explanations, risks, lifestyle & monitoring
- Output EXACTLY six sections with emojis
`;

    const userPrompt = `
PATIENT_NAME: ${name || "Guest"}
MEDIMIND_CODE: ${userCode || "ANON-0000"}

SYMPTOMS: ${symptoms}
AGE: ${age}
MEDICAL_HISTORY: ${history || "None"}
PRESCRIPTION: ${req.file ? `Uploaded (${req.file.originalname})` : "None"}

Respond EXACTLY in this format:

🔍 SYMPTOM_ANALYZER:
📊 RISK_PREDICTOR:
🛡️ FRAUD_DETECTOR:
🔐 SECURITY_GUARDIAN:
🤖 COORDINATOR_INSIGHTS:
💊 RECOMMENDATIONS:
`;

    // Call Ollama
    const fullResponse = await callOllama([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]);

    // Split into individual agent sections
    const agents = parseAgentResponse(fullResponse);

    // Insert into Supabase "cases" table
    const { data, error } = await supabase
      .from("cases")
      .insert({
        user_id: null, // later can map from auth user
        symptoms,
        age: parseInt(age, 10),
        history: history || null,
        symptom_analyzer: agents.symptom || null,
        risk_predictor: agents.risk || null,
        fraud_detector: agents.fraud || null,
        security_guardian: agents.security || null,
        coordinator_insights: agents.coordinator || null,
        recommendations: agents.recommendations || null,
        full_response: fullResponse,
        prescription_text: null, // OCR later
        prescription_flag: req.file ? "UPLOADED" : "NONE"
      })
      .select();

    if (error) {
      console.error("Supabase insert error:", error);
      return res
        .status(500)
        .json({ error: "Failed to save case to database" });
    }

    res.json({
      fullResponse,
      agents,
      caseId: data?.[0]?.id || null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Ollama inference failed. Make sure Ollama is running."
    });
  }
});

/* ================== CHAT ================== */

app.post("/api/chat", async (req, res) => {
  try {
    const { caseContext, question } = req.body;

    const reply = await callOllama([
      {
        role: "system",
        content:
          "You are MediMind follow-up assistant. Continue discussion based on the given case context. Do NOT give medical prescriptions or tell the user to visit any doctor / hospital. Focus on explanations, risks, lifestyle and monitoring."
      },
      { role: "user", content: caseContext },
      { role: "user", content: question }
    ]);

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Chat failed" });
  }
});

/* ================== HEALTH CHECK (OPTIONAL) ================== */

app.get("/api/health", async (_req, res) => {
  try {
    const { error } = await supabase.from("cases").select("id").limit(1);
    if (error) throw error;

    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

/* ================== START ================== */

app.listen(PORT, () => {
  console.log(`✅ MediMind running at http://localhost:${PORT}`);
  console.log(`🤖 Model: ${OLLAMA_MODEL}`);
});
