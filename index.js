// server.js (UPDATED)
// --------------------
// Requirements:
// - Set these environment variables in your environment or .env:
//   PORT, OPENAI_API_KEY,
//   GOOGLE_PROJECT_ID,
//   GOOGLE_APPLICATION_CREDENTIALS (path to GCP service account key used by Storage+Speech),
//   GOOGLE_DRIVE_KEYFILE (path to service account key used for Drive, can be same as above),
//   GCS_BUCKET_NAME,
//   DRIVE_PARENT_FOLDER_ID
//
// Notes:
// - Ensure the service account used for Drive has domain-wide or Drive API permissions and
//   the Drive folder ID exists and the service account has access.
// - Keep key file paths outside your repo and reference via env vars (as shown).

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { Storage } = require('@google-cloud/storage');
const speech = require('@google-cloud/speech').v1p1beta1;
const { OpenAI } = require('openai');
const { Document, Packer, Paragraph } = require('docx');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Readable } = require('stream');

ffmpeg.setFfmpegPath(ffmpegPath);

// Firebase admin (your own file)
const admin = require('./firebaseAdmin');
const db = admin.database();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

// ---- Config / env ----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GOOGLE_PROJECT_ID = process.env.GOOGLE_PROJECT_ID || 'speech-to-text-459913';
const GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS; // e.g. /etc/secrets/smart-minutes-key.json
const GOOGLE_DRIVE_KEYFILE = process.env.GOOGLE_DRIVE_KEYFILE || GOOGLE_APPLICATION_CREDENTIALS;
const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'smart-minutes-bucket';
const DRIVE_PARENT_FOLDER_ID = process.env.DRIVE_PARENT_FOLDER_ID || '1S1us2ikMWxmrfraOnHbAUNQqMSXywfbr';

// validate required env
if (!GOOGLE_APPLICATION_CREDENTIALS) {
  console.warn('Warning: GOOGLE_APPLICATION_CREDENTIALS is not set. Google clients may fail.');
}

// ---- Logging helper ----
let logStorage = [];
function logHandler(message, type = 'info') {
  const entry = { timestamp: new Date().toISOString(), type, message };
  logStorage.push(entry);
  if (logStorage.length > 200) logStorage.shift();
  // Print condensed to console
  console.log(`[${entry.type.toUpperCase()}] ${entry.timestamp}: ${entry.message}`);
}

// ---- Ensure local uploads folder ----
const localUploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(localUploadDir)) {
  fs.mkdirSync(localUploadDir, { recursive: true });
  logHandler('Created local uploads folder', 'system');
}

// ---- Multer in-memory storage ----
const upload = multer({ storage: multer.memoryStorage() });

// ---- Google clients ----
const storage = new Storage({
  projectId: GOOGLE_PROJECT_ID,
  keyFilename: GOOGLE_APPLICATION_CREDENTIALS,
});

const speechClient = new speech.SpeechClient({
  projectId: GOOGLE_PROJECT_ID,
  keyFilename: GOOGLE_APPLICATION_CREDENTIALS,
});

// Drive client will be initialized asynchronously (see below)
let driveClient = null;

// ---- OpenAI client ----
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// ---- FFmpeg conversion helper ----
function bufferToStream(buffer) {
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}

function convertBufferToMP3(buffer) {
  return new Promise((resolve, reject) => {
    // create temp files to avoid stream complexities with ffmpeg-static
    const inputPath = path.join(os.tmpdir(), `input-${Date.now()}`);
    const outputPath = path.join(os.tmpdir(), `output-${Date.now()}.mp3`);

    // Try to detect input extension heuristically. If buffer is m4a, give inputPath .m4a.
    // We'll simply write without extension — ffmpeg will usually detect from headers.
    fs.writeFileSync(inputPath, buffer);

    ffmpeg(inputPath)
      .setFfmpegPath(ffmpegPath)
      .toFormat('mp3')
      .on('error', (err) => {
        logHandler(`FFmpeg error: ${err.message}`, 'error');
        // cleanup
        try { fs.unlinkSync(inputPath); } catch {}
        try { fs.unlinkSync(outputPath); } catch {}
        reject(err);
      })
      .on('end', () => {
        try {
          const mp3Buffer = fs.readFileSync(outputPath);
          fs.unlinkSync(inputPath);
          fs.unlinkSync(outputPath);
          logHandler(`Conversion finished, buffer size: ${mp3Buffer.length} bytes`, 'success');
          resolve(mp3Buffer);
        } catch (err) {
          reject(err);
        }
      })
      .save(outputPath);
  });
}

// ---- Corrections mapping (kept from your original) ----
const corrections = {
  "made your": "medyo",
  "and": "ang",
  "yong": "iyong",
  "business": "negosyo",
  "ASAP": "as soon as possible",
  "Wrap up": "Tapusin na",
  "mo na": "muna",
  "Questions or clarification regarding sa napagusapan natin": "May tanong o paglilinaw ba tungkol sa napag-usapan natin",
  "Please pakisend na lang sa email or GC after.": "Pakisend na lang sa email o GC pagkatapos.",
  "Sorry, medyo choppy ka kanina, can you repeat": "Sorry, medyo choppy ka kanina. Pwede mo bang ulitin?",
  "Di na ko": "Di na ako",
  "take a": "teka",
  "wedding": "kasal",
  "goes to": "para kay",
  "Point a": "Punta",
  "two log": "tulog",
  "Zeus": "sus",
  "yun yon": "iyon yun",
  "union": "unyon",
  "wanna": "gusto",
  "we na": "uwi na",
  "bucket": "bakit",
  "front ka": "harap ka",
  "punata ka": "punta ka",
  "point account": "puntahan ka",
  "shut up matulog": "sarap matulog",
  "unknown": "hindi alam",
  "a known": "anong",
  "indeed ko": "hindi ko",
  "nak eat a": "nakita",
  "nakita move a": "nakita mo ba",
  "none john": "nandyan",
  "helica": "halika",
  "tada": "tara",
  "low tide yo": "laro tayo",
  "tada kind tayo": "tara kain tayo",
  "kung too big": "ng tubig",
  "bali kana": "bahala ka na",
  "can tie you": "kain tayo",
  "keyta": "kita",
  "font a hanky ta": "puntahan kita",
  "bucket sakali": "baka sakali",
  "uncut mo": "ang cute mo",
  "annie needs a bra": "ang init sobra",
  "none jhan siya": "nandyan siya",
  "shocker": "tsaka",
  "chucka": "tsaka",
  "canon": "kanin",
  "parry": "pare",
  "terra": "tara",
  "uh oh": "oo",
  "ba allah ka": "bahala ka",
  "whale lang": "wait lang",
  "pick a muna": "teka muna",
  "tik muna": "teka muna",
  "dama ba": "tama ba",
  "basis": "base",
  "base is": "base",
  "ano yon": "ano yun",
  "an onion": "ano yun",
  "anyone": "ano yun",
  "common stack": "kamusta",
  "see gain of lease": "sige na please",
  "Kylie long kung too big": "kailangan ko ng tubig",
  "i own kona": "ayoko na",
  "none dito": "nandito",
  "who we now": "uwi na",
  "shoes": "sus"
};

function applyCorrections(text) {
  for (const [wrong, correct] of Object.entries(corrections)) {
    // use word boundary but still allow multi-word phrases
    const pattern = new RegExp(`\\b${escapeRegExp(wrong)}\\b`, 'gi');
    text = text.replace(pattern, correct);
  }
  return text;
}
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- Upload buffer to GCS ----
async function uploadBufferToGCS(buffer, fileName) {
  const bucket = storage.bucket(GCS_BUCKET_NAME);
  const file = bucket.file(fileName);
  await file.save(buffer, {
    metadata: { contentType: 'audio/mp3' },
    resumable: false,
  });
  logHandler(`Uploaded to GCS: gs://${GCS_BUCKET_NAME}/${fileName}`, 'success');
  return {
    gcsPath: `gs://${GCS_BUCKET_NAME}/${fileName}`,
    publicUrl: `https://storage.googleapis.com/${GCS_BUCKET_NAME}/${fileName}`,
  };
}

// ---- Transcribe from GCS ----
async function transcribe(gcsUri, options = {}) {
  // options: { languageCode, diarizationSpeakerCount, sampleRateHertz }
  const languageCode = options.languageCode || 'fil-PH';
  const diarizationSpeakerCount = options.diarizationSpeakerCount || 2;

  const request = {
    audio: { uri: gcsUri },
    config: {
      encoding: 'MP3',
      sampleRateHertz: 44100,
      languageCode,
      enableSpeakerDiarization: true,
      diarizationSpeakerCount,
      enableAutomaticPunctuation: true,
      model: 'default',
      audioChannelCount: 1,
    },
  };

  const [operation] = await speechClient.longRunningRecognize(request);
  const [response] = await operation.promise();

  // Build transcript grouped by speaker (use all results)
  const wordsInfo = [];
  for (const res of response.results || []) {
    const alt = res.alternatives && res.alternatives[0];
    if (!alt) continue;
    if (alt.words) {
      wordsInfo.push(...alt.words);
    } else {
      // fallback: append full transcript as speaker 1
      wordsInfo.push({ word: alt.transcript, speakerTag: 1 });
    }
  }

  if (!wordsInfo.length) {
    // fallback to concatenated transcript text if words info absent
    const text = (response.results || []).map(r => (r.alternatives[0] && r.alternatives[0].transcript) || '').join(' ');
    return text.trim();
  }

  let transcript = '';
  let currentSpeaker = null;
  for (const w of wordsInfo) {
    if (w.speakerTag !== currentSpeaker) {
      currentSpeaker = w.speakerTag;
      transcript += `\n\nSpeaker ${currentSpeaker}:\n`;
    }
    transcript += (w.word || '') + ' ';
  }

  return transcript.trim();
}

// ---- Initialize Drive client (async) ----
async function initDriveClient() {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: GOOGLE_DRIVE_KEYFILE,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    const authClient = await auth.getClient();
    driveClient = google.drive({ version: 'v3', auth: authClient });

    // quick test access (list folder)
    try {
      const resp = await driveClient.files.list({
        q: `'${DRIVE_PARENT_FOLDER_ID}' in parents and trashed = false`,
        pageSize: 1,
        fields: 'files(id, name)',
      });
      logHandler('Drive client initialized and parent folder accessible', 'system');
    } catch (err) {
      logHandler(`Drive parent folder check failed: ${err.message}`, 'warn');
    }
  } catch (err) {
    logHandler(`Failed to initialize Drive client: ${err.message}`, 'error');
  }
}
initDriveClient().catch(err => logHandler(`Drive init error: ${err.message}`, 'error'));

// ---- Routes ----

app.post('/transcribe', upload.single('file'), async (req, res) => {
  logHandler('Transcription request received', 'info');

  try {
    const { uid } = req.body;
    if (!req.file || !uid) {
      return res.status(400).json({ success: false, message: 'Missing file or UID' });
    }

    const originalName = req.file.originalname || 'upload';
    let finalBuffer = req.file.buffer;
    let finalFilename = originalName;

    // Convert m4a or other non-mp3 to mp3
    if (/\.m4a$/i.test(originalName) || /\.wav$/i.test(originalName) || /\.aac$/i.test(originalName)) {
      logHandler('Converting input file to MP3', 'info');
      finalBuffer = await convertBufferToMP3(finalBuffer);
      finalFilename = originalName.replace(/\.[^/.]+$/, '') + '.mp3';
    } else if (!/\.mp3$/i.test(originalName)) {
      // Try convert to mp3 for consistency
      logHandler('Input not mp3 — converting to MP3 for consistent processing', 'info');
      finalBuffer = await convertBufferToMP3(finalBuffer);
      finalFilename = originalName.replace(/\.[^/.]+$/, '') + '.mp3';
    }

    const safeName = finalFilename.replace(/\.[^/.]+$/, '');
    const fileName = `${Date.now()}-${safeName}.mp3`;

    // upload to gcs
    const { gcsPath, publicUrl } = await uploadBufferToGCS(finalBuffer, fileName);

    // create job record
    const jobRef = db.ref(`transcriptionJobs/${uid}`).push();
    const jobId = jobRef.key;
    await jobRef.set({
      uid,
      filename: fileName,
      gcsUri: gcsPath,
      publicUrl,
      status: 'Pending',
      createdAt: Date.now(),
    });

    // Try fast transcription with timeout
    const FAST_TIMEOUT = 60 * 1000; // 60s
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), FAST_TIMEOUT)
    );

    try {
      const rawTranscript = await Promise.race([transcribe(gcsPath), timeoutPromise]);
      const cleanedTranscript = applyCorrections(rawTranscript);

      await jobRef.update({
        text: cleanedTranscript,
        status: 'Completed',
        completedAt: Date.now(),
      });

      return res.status(200).json({
        success: true,
        jobId,
        transcription: cleanedTranscript,
        gcsPath,
        publicUrl,
      });
    } catch (err) {
      if (err.message === 'Timeout') {
        // kick off background processing (non-blocking)
        logHandler(`[Job ${jobId}] Transcription timed out; continuing in background`, 'warn');
        // Fire-and-forget background processing: it updates Firebase when done
        processTranscriptionJob(jobId, uid, gcsPath, fileName);
        return res.status(202).json({
          success: true,
          jobId,
          message: 'Transcription is taking longer. Check /status/:uid/:jobId for updates.',
        });
      } else {
        throw err;
      }
    }
  } catch (error) {
    logHandler(`Transcription Error: ${error.message}`, 'error');
    return res.status(500).json({ success: false, message: error.message });
  }
});

async function processTranscriptionJob(jobId, uid, gcsPath, fileName) {
  logHandler(`[Job ${jobId}] Background transcription started`, 'info');
  const jobRef = db.ref(`transcriptionJobs/${uid}/${jobId}`);

  try {
    const rawTranscript = await transcribe(gcsPath, { diarizationSpeakerCount: 4 });
    const cleanedTranscript = applyCorrections(rawTranscript);

    await jobRef.update({
      text: cleanedTranscript,
      status: 'Completed',
      completedAt: Date.now(),
    });

    logHandler(`[Job ${jobId}] Background transcription completed`, 'success');
  } catch (err) {
    logHandler(`[Job ${jobId}] Background transcription failed: ${err.message}`, 'error');
    await jobRef.update({ status: 'Failed', error: err.message });
  }
}

app.get('/status/:uid/:jobId', async (req, res) => {
  const { uid, jobId } = req.params;
  try {
    const snapshot = await db.ref(`transcriptionJobs/${uid}/${jobId}`).once('value');
    if (!snapshot.exists()) return res.status(404).json({ success: false, message: 'Job not found' });
    res.json({ success: true, job: snapshot.val() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// simple transcript read (local fallback)
app.get('/transcript', (req, res) => {
  try {
    const transcript = fs.readFileSync(path.join(__dirname, 'transcript.txt'), 'utf-8');
    res.json({ success: true, transcription: transcript });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Could not read transcript file.' });
  }
});

// ---- Summarize endpoint (create templates + upload to Drive) ----
app.post('/summarize', upload.none(), async (req, res) => {
  try {
    const userId = req.body?.userId;
    const audioFileName = req.body?.audioFileName || 'Transcription';
    const mp3BaseName = audioFileName.replace(/\.[^/.]+$/, '');
    let transcript = req.body?.transcript;

    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }

    if (!transcript) {
      try {
        transcript = fs.readFileSync(path.join(__dirname, 'transcript.txt'), 'utf-8');
        logHandler('Loaded transcript from local file.', 'info');
      } catch (err) {
        return res.status(400).json({ success: false, message: 'Transcript is missing and no fallback file found.' });
      }
    }

    // Templates
    const templates = [
      {
        name: 'Template-Formal',
        dbField: 'formal_template',
        prompt: `Summarize the following transcription and format it like a formal Minutes of the Meeting including meeting name, date, time, venue, attendees, call to order, matters arising, agenda (with discussions and action points), announcements, and adjournment. Here is the transcription:\n\n${transcript}`,
      },
      {
        name: 'Template-Simple',
        dbField: 'simple_template',
        prompt: `Summarize and format this as a simple Minutes of the Meeting with Meeting Title, Date, Time, Venue, Attendees, Key Points Discussed, Action Items, and Closing Notes.\n\nTranscript:\n${transcript}`,
      },
      {
        name: 'Template-Detailed',
        dbField: 'detailed_template',
        prompt: `Create a detailed Minutes of the Meeting with Meeting Information (name, date, time, venue, participants), Detailed Agenda (for each item: title, discussion, decisions, action points), other announcements, and closing.\n\nTranscript:\n${transcript}`,
      },
    ];

    const results = [];
    const summariesTable = {};

    // iterate and call OpenAI
    for (const t of templates) {
      // Using Chat Completions via openai.chat.completions.create (classic)
      // If your OpenAI client differs, adapt this call to match the client version you use.
      const aiResponse = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You are a helpful assistant who formats meeting transcriptions into Minutes of the Meeting.' },
          { role: 'user', content: t.prompt },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      });

      const summaryText = (aiResponse?.choices?.[0]?.message?.content || aiResponse?.choices?.[0]?.text || '').trim();
      if (!summaryText) {
        logHandler(`OpenAI returned empty for ${t.name}`, 'warn');
      }

      // Build DOCX
      const doc = new Document({
        creator: 'Smart Minutes App',
        title: `Minutes of the Meeting - ${t.name}`,
        description: 'Auto-generated summary of transcribed audio.',
        sections: [
          {
            children: summaryText
              .split(/\r?\n/)
              .filter(line => line.trim() !== '')
              .map(line => new Paragraph(line)),
          },
        ],
      });

      const buffer = await Packer.toBuffer(doc);
      const fileName = `${mp3BaseName}-${t.name}-${Date.now()}.docx`;

      // Upload docx to Google Drive (driveClient required)
      if (!driveClient) {
        logHandler('Drive client not initialized; skipping Drive upload', 'error');
        throw new Error('Drive client not initialized');
      }

      const bufferStream = new Readable();
      bufferStream.push(buffer);
      bufferStream.push(null);

      const fileMetadata = {
        name: fileName,
        parents: [DRIVE_PARENT_FOLDER_ID],
      };

      const media = {
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        body: bufferStream,
      };

      const driveRes = await driveClient.files.create({
        requestBody: fileMetadata,
        media,
        fields: 'id',
      });

      const fileId = driveRes.data.id;

      // Make file readable by anyone (public link)
      try {
        await driveClient.permissions.create({
          fileId,
          requestBody: { role: 'reader', type: 'anyone' },
        });
      } catch (permErr) {
        // sometimes service account cannot assign "anyone" permission; still continue
        logHandler(`Drive permission warning for file ${fileId}: ${permErr.message}`, 'warn');
      }

      const publicLink = `https://drive.google.com/file/d/${fileId}/view?usp=sharing`;

      summariesTable[t.dbField] = publicLink;
      results.push({ template: t.name, link: publicLink });

      logHandler(`Created & uploaded ${t.name}`, 'success');
    }

    // Save to Firebase
    const tableRef = db.ref(`summaries/${userId}`).push();
    await tableRef.set({
      audioFileName,
      createdAt: admin.database.ServerValue.TIMESTAMP,
      ...summariesTable,
    });

    res.json({
      success: true,
      message: 'All templates processed and uploaded to Google Drive.',
      results,
      tableRecordId: tableRef.key,
    });

  } catch (error) {
    logHandler(`Error in /summarize: ${error.message}`, 'error');
    res.status(500).json({ success: false, message: 'Error during summarization or file handling.', error: error.message });
  }
});

// fetch all summaries for a user
app.get('/allminutes/:id', async (req, res) => {
  const userId = req.params.id;
  if (!userId) return res.status(400).json({ success: false, message: 'User ID required' });

  try {
    const snapshot = await db.ref(`summaries/${userId}`).once('value');
    const data = snapshot.val();
    const minutes = data ? Object.entries(data).map(([id, val]) => ({ summaryId: id, ...val })) : [];
    res.json({ success: true, minutes });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.listen(PORT, () => {
  logHandler(`Server running on port ${PORT}`, 'system');
});
