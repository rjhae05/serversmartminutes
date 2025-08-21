require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { Storage } = require('@google-cloud/storage');
const speech = require('@google-cloud/speech').v1p1beta1;
const fs = require('fs');
const { OpenAI } = require('openai');
const { Document, Packer, Paragraph } = require('docx');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const os = require('os'); 

const path = require("path");

const { Readable, Writable } = require("stream");
ffmpeg.setFfmpegPath(ffmpegPath); 

require('dotenv').config();

const admin = require('./firebaseAdmin');
const db = admin.database();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// --- Configurations and Keys ---
const openaiKey = process.env.OPENAI_API_KEY;
const projectId = 'speech-to-text-459913';
const bucketName = 'smart-minutes-bucket';

// Set GCP credentials environment variable
process.env.GOOGLE_APPLICATION_CREDENTIALS = '/etc/secrets/smart-minutes-key.json';

const storage = new Storage({ projectId });
const speechClient = new speech.SpeechClient();
const openai = new OpenAI({ apiKey: openaiKey });

// Multer config for in-memory file upload
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.static(__dirname));

// ——— Logger ———
let logStorage = [];
function logHandler(message, type = "info") {
  const entry = {
    timestamp: new Date().toISOString(),
    type,
    message,
  };
  logStorage.push(entry);

  if (logStorage.length > 100) logStorage.shift();
  console.log(`[${entry.type.toUpperCase()}] ${entry.timestamp}: ${entry.message}`);
}

// --- Helpers ---
function bufferToStream(buffer) {
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}

function convertM4ABufferToMP3Buffer(inputBuffer) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const inputStream = bufferToStream(inputBuffer);

    const writableStream = new Writable({
      write(chunk, encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });

    ffmpeg(inputStream)
      .inputFormat("m4a")
      .audioCodec("libmp3lame")
      .audioChannels(1) // mono
      .audioBitrate("128k")
      .audioFrequency(16000) // match Google STT
      .format("mp3")
      .on("error", reject)
      .on("end", () => resolve(Buffer.concat(chunks)))
      .pipe(writableStream, { end: true });
  });
}

// Google Drive setup
const auth = new google.auth.GoogleAuth({
  keyFile: '/etc/secrets/smartminutesMoMkey.json',
  scopes: ['https://www.googleapis.com/auth/drive'],
});

let driveClient;
const parentFolderId = '1S1us2ikMWxmrfraOnHbAUNQqMSXywfbr';

(async () => {
  try {
    const authClient = await auth.getClient();
    driveClient = google.drive({ version: 'v3', auth: authClient });
    await testDriveAccess();
  } catch (error) {
    console.error('Drive Auth Init Error:', error);
  }
})();

async function testDriveAccess() {
  try {
    const res = await driveClient.files.list({
      q: `'${parentFolderId}' in parents`,
      fields: 'files(id, name)',
    });
    if (res.data.files?.length) {
      console.log(`Drive folder accessible. Files: ${res.data.files.map(f => f.name).join(', ')}`);
    } else {
      console.log('Drive folder accessible but empty.');
    }
  } catch (error) {
    console.error('Drive access test failed:', error.message);
  }
}

// --- Auto-correction mappings ---
const corrections = {
  'Thank you, sir. Have a good day in the': 'Thank you sa pag attend',
  young: 'yoong',
};

function applyCorrections(text) {
  for (const [wrong, correct] of Object.entries(corrections)) {
    text = text.replace(new RegExp(`\\b${wrong}\\b`, 'gi'), correct);
  }
  return text;
}

// --- Upload file buffer to Google Cloud Storage ---
async function uploadToGCS(buffer, filename) {
  await storage.bucket(bucketName).file(filename).save(buffer, {
    metadata: { contentType: 'audio/mpeg' },
    resumable: false,
  });
  console.log('Uploaded to GCS at:', filename);
  return `gs://${bucketName}/${filename}`;
}

// --- Transcribe audio from GCS URI using Google Speech API ---
async function transcribe(gcsUri) {
  const request = {
    audio: { uri: gcsUri },
    config: {
      encoding: 'MP3',
      sampleRateHertz: 44100,
      languageCode: 'fil-PH',
      alternativeLanguageCodes: ['en-US'],
       audioChannelCount: 1, // ✅ align with conversion
      enableSpeakerDiarization: true,
      diarizationSpeakerCount: 2,
      model: 'default',
    },
  };
  const [operation] = await speechClient.longRunningRecognize(request);
  const [response] = await operation.promise();

  // Extract last result's words for speaker diarization
  const wordsInfo = response.results.slice(-1)[0].alternatives[0].words;

  let transcript = '';
  let currentSpeaker = null;

  for (const wordInfo of wordsInfo) {
    if (wordInfo.speakerTag !== currentSpeaker) {
      currentSpeaker = wordInfo.speakerTag;
      transcript += `\n\nSpeaker ${currentSpeaker}:\n`;
    }
    transcript += wordInfo.word + ' ';
  }

  return transcript.trim();
}

// --- Routes ---

// Login endpoint
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email/password required' });
  }

  try {
    const snapshot = await db.ref('Users').once('value');
    const users = snapshot.val() || {};
    const userEntry = Object.entries(users).find(([_, u]) => u.email === email && u.password === password);

    if (userEntry) {
      const userId = userEntry[0];
      return res.json({ success: true, message: 'Login successful', uid: userId });
    } else {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({ success: false, message: 'Error during login' });
  }
});
// Transcribe
app.post("/transcribe", upload.single("file"), async (req, res) => {
  console.log("🎤 Transcription request received");
  const { uid } = req.body;

  if (!req.file || !uid)
    return res.status(400).json({ success: false, message: "File + UID required" });

  try {
    const originalName = req.file.originalname;
    let finalBuffer = req.file.buffer;
    let finalFilename = originalName;

    if (
      originalName.toLowerCase().endsWith(".m4a") ||
      req.file.mimetype === "audio/m4a" ||
      req.file.mimetype === "audio/mp4"
    ) {
      console.log("🔄 Converting M4A to MP3...");
      finalBuffer = await convertM4ABufferToMP3Buffer(req.file.buffer);
      finalFilename = originalName.replace(/\.[^/.]+$/, "") + ".mp3";
    }

    const gcsFilename = `${Date.now()}-${finalFilename}`;
    const gcsUri = await uploadToGCS(finalBuffer, gcsFilename);

    console.log("📝 Transcribing from:", gcsUri);
    const rawTranscript = await transcribe(gcsUri);
    const cleanedTranscript = applyCorrections(rawTranscript);

    const newRef = db.ref(`transcriptions/${uid}`).push();
    await newRef.set({
      filename: finalFilename,
      text: cleanedTranscript,
      gcsUri,
      status: "Completed",
      createdAt: Date.now(),
    });

    fs.writeFileSync("./transcript.txt", cleanedTranscript);

    res.json({
      success: true,
      transcription: cleanedTranscript,
      audioFileName: finalFilename,
    });
  } catch (error) {
    console.error("Transcription Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get transcript text
app.get('/transcript', (req, res) => {
  try {
    const transcript = fs.readFileSync('./transcript.txt', 'utf-8');
    res.json({ success: true, transcription: transcript });
  } catch (error) {
    console.error('Error reading transcript.txt:', error);
    res.status(500).json({ success: false, message: 'Could not read transcript file.' });
  }
});

// Summarize endpoint
app.post('/summarize', upload.none(), async (req, res) => {
  try {
    const userId = req.body?.userId;
    const audioFileName = req.body?.audioFileName || 'Transcription';
    const mp3BaseName = audioFileName.replace(/\.[^/.]+$/, '');

    let transcript = req.body?.transcript;

    if (!transcript) {
      try {
        transcript = fs.readFileSync('./transcript.txt', 'utf-8');
        console.log(' Loaded transcript from local file.');
      } catch {
        return res.status(400).json({
          success: false,
          message: 'Transcript is missing and no fallback file was found.',
        });
      }
    }

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'Missing userId in request body.',
      });
    }

    // Summarization templates
    const templates = [
      {
        name: 'Template-Formal',
        dbField: 'formal_template',
        prompt: `Summarize the following transcription and format it like this formal Minutes of the Meeting:

[MEETING NAME:]
[DATE:]
[TIME:]
[VENUE:]
[PRESENT:]

[CALL TO ORDER:]
[Who started the meeting and at what time.]

[MATTERS ARISING:]
• Bullet points of major topics.

[MEETING AGENDA:]
• Agenda Title
   - Discussion points
   - Action points

[ANNOUNCEMENTS:]
[List]

[ADJOURNMENT:]
[Closing remarks]

Here is the transcription:
"${transcript}"`,
      },
      {
        name: 'Template-Simple',
        dbField: 'simple_template',
        prompt: `Summarize and format this as a simple MoM:

Meeting Title:
Date:
Time:
Venue:
Attendees:

Key Points Discussed:
- ...

Action Items:
- ...

Closing Notes:
"${transcript}"`,
      },
      {
        name: 'Template-Detailed',
        dbField: 'detailed_template',
        prompt: `Summarize this transcript into a detailed Minutes of the Meeting with:

Meeting Information
- Name
- Date
- Time
- Venue
- Participants

Detailed Agenda:
For each item:
• Title
• Discussions
• Decisions
• Action points

Other Announcements:
Closing:
"${transcript}"`,
      },
    ];

    const results = [];
    const summariesTable = {};

    for (const template of templates) {
      const aiResponse = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You are a helpful assistant who formats meeting transcriptions.' },
          { role: 'user', content: template.prompt },
        ],
        temperature: 0.4,
      });

      const summaryText = aiResponse.choices[0].message.content;

      // Generate docx document
      const doc = new Document({
        creator: 'Smart Minutes App',
        title: `Minutes of the Meeting - ${template.name}`,
        description: 'Auto-generated summary of transcribed audio.',
        sections: [
          {
            children: summaryText
              .split('\n')
              .filter(line => line.trim() !== '')
              .map(line => new Paragraph(line)),
          },
        ],
      });

      const fileName = `${mp3BaseName}-${template.name}-${Date.now()}.docx`;
      const buffer = await Packer.toBuffer(doc);

      // Upload docx to Google Drive
      const { Readable } = require('stream');
      const bufferStream = new Readable();
      bufferStream.push(buffer);
      bufferStream.push(null);

      const fileMetadata = {
        name: fileName,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        parents: [parentFolderId],
      };

      const media = { mimeType: fileMetadata.mimeType, body: bufferStream };

      const driveRes = await driveClient.files.create({
        requestBody: fileMetadata,
        media,
        fields: 'id',
      });

      const fileId = driveRes.data.id;

      // Make file public
      await driveClient.permissions.create({
        fileId,
        requestBody: { role: 'reader', type: 'anyone' },
      });

      const publicLink = `https://drive.google.com/file/d/${fileId}/view?usp=sharing`;

      summariesTable[template.dbField] = publicLink;
      results.push({ template: template.name, link: publicLink });

      console.log(` Created and uploaded: ${template.name}`);
    }

    // Save summary links to Firebase
    const tableRef = db.ref(`summaries/${userId}`).push();
    await tableRef.set({
      audioFileName,
      createdAt: admin.database.ServerValue.TIMESTAMP,
      ...summariesTable,
    });

    res.json({
      success: true,
      message: 'All templates processed, uploaded to Google Drive, and saved under user.',
      results,
      tableRecordId: tableRef.key,
    });

  } catch (error) {
    console.error(' Error in /summarize:', error);
    res.status(500).json({
      success: false,
      message: 'Error during summarization or file handling.',
      error: error.message,
    });
  }
});

// Fetch all summaries for a user
app.get('/allminutes/:id', async (req, res) => {
  const userId = req.params.id;
  if (!userId) {
    return res.status(400).json({ success: false, message: 'User ID required' });
  }

  try {
    const snapshot = await db.ref(`summaries/${userId}`).once('value');
    const data = snapshot.val();
    const minutes = data ? Object.entries(data).map(([id, val]) => ({ summaryId: id, ...val })) : [];
    res.json({ success: true, minutes });
  } catch (error) {
    console.error('Fetch Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Start the server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));





















