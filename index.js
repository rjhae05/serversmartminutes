const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Storage } = require('@google-cloud/storage');
const speech = require('@google-cloud/speech').v1p1beta1;
const fs = require('fs');
const { OpenAI } = require('openai');
const { Document, Packer, Paragraph } = require('docx');
const { google } = require('googleapis');
require('dotenv').config();

const admin = require('./firebaseAdmin');
const db = admin.database();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// Keys and Config
const openaiKey = process.env.OPENAI_API_KEY;
const projectId = 'speech-to-text-459913';
const bucketName = 'smart-minutes-bucket';
process.env.GOOGLE_APPLICATION_CREDENTIALS = '/etc/secrets/smart-minutes-key.json';

const storage = new Storage({ projectId });
const speechClient = new speech.SpeechClient();
const openai = new OpenAI({ apiKey: openaiKey });

// Multer
const upload = multer({ storage: multer.memoryStorage() });

// Google Drive setup
const auth = new google.auth.GoogleAuth({
  keyFile: '/etc/secrets/smartminutesMoMkey.json',
  scopes: ['https://www.googleapis.com/auth/drive']
});
let driveClient;
const parentFolderId = '1S1us2ikMWxmrfraOnHbAUNQqMSXywfbr';

(async () => {
  try {
    const authClient = await auth.getClient();
    driveClient = google.drive({ version: 'v3', auth: authClient });
    await testDriveAccess();
  } catch (e) {
    console.error('Drive Auth Init Error:', e);
  }
})();

async function testDriveAccess() {
  try {
    const res = await driveClient.files.list({
      q: `'${parentFolderId}' in parents`,
      fields: 'files(id, name)',
    });
    console.log(res.data.files?.length 
      ? `Drive folder accessible. Files: ${res.data.files.map(f => f.name).join(', ')}`
      : 'Drive folder accessible but empty.'
    );
  } catch (e) {
    console.error('Drive access test failed:', e.message);
  }
}

// Auto corrections
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

// Upload and Transcription
async function uploadToGCS(buffer, filename) {
  await storage.bucket(bucketName).file(filename).save(buffer, {
    metadata: { contentType: 'audio/mpeg' },
    resumable: false,
  });
  console.log('Uploaded to GCS at:', filename);
  return `gs://${bucketName}/${filename}`;
}

async function transcribe(gcsUri) {
  const request = {
    audio: { uri: gcsUri },
    config: {
      encoding: 'MP3',
      sampleRateHertz: 16000,
      languageCode: 'fil-PH',
      alternativeLanguageCodes: ['en-US'],
      enableSpeakerDiarization: true,
      diarizationSpeakerCount: 2,
      model: 'default',
    },
  };
  const [op] = await speechClient.longRunningRecognize(request);
  const [response] = await op.promise();
  const wordsInfo = response.results.slice(-1)[0].alternatives[0].words;
  let transcript = '';
  let current = null;
  for (const w of wordsInfo) {
    if (w.speakerTag !== current) {
      current = w.speakerTag;
      transcript += `\n\nSpeaker ${current}:\n`;
    }
    transcript += w.word + ' ';
  }
  return transcript.trim();
}

// Routes

// Login
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, message: 'Email/password required' });

  try {
    const snapshot = await db.ref('Users').once('value');
    const userId = Object.entries(snapshot.val() || {}).find(([_, u]) => u.email === email && u.password === password)?.[0];
    return userId
      ? res.json({ success: true, message: 'Login successful', uid: userId })
      : res.status(401).json({ success: false, message: 'Invalid credentials' });
  } catch (e) {
    console.error('Login Error:', e);
    res.status(500).json({ success: false, message: 'Error during login' });
  }
});
// Transcribe
app.post('/transcribe', upload.single('file'), async (req, res) => {
  console.log('📝 Transcription request received');
  const { uid } = req.body;
  if (!req.file || !uid) return res.status(400).json({ success: false, message: 'File and UID required' });

  try {
    const original = req.file.originalname;
    const gcsFilename = `${Date.now()}-${original}`;
    const gcsUri = await uploadToGCS(req.file.buffer, gcsFilename);

    console.log(`📤 Uploaded file: ${original}`);
    console.log(`🎙️ Transcribing from: ${gcsUri}`);

    const rawTranscript = await transcribe(gcsUri);
    const cleaned = applyCorrections(rawTranscript);

    // ✅ Print transcription output to console
    console.log('\n📄 Transcription Output:\n');
    console.log(cleaned);
    console.log('\n📄 End of Transcription\n');

    const timestamp = Date.now();
    const newRef = db.ref(`transcriptions/${uid}`).push();
    await newRef.set({ filename: original, text: cleaned, gcsUri, status: 'Completed', createdAt: timestamp });

    fs.writeFileSync('./transcript.txt', cleaned);
    console.log('✅ Transcription completed and saved locally.');

    // Declare and assign JSON response object here
    const jsonResponse = {
      success: true,
      transcription: cleaned,
      audioFileName: original
    };

    console.log('📦 Sending JSON Response:', JSON.stringify(jsonResponse, null, 2));
    // Send response once
    res.json(jsonResponse);
    
  } catch (e) {
    console.error('❌ Transcription Error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ✅ Add this route to your server.js (or index.js)
app.get('/transcript', (req, res) => {
  try {
    const transcript = fs.readFileSync('./transcript.txt', 'utf-8');
    res.json({ success: true, transcription: transcript });
  } catch (err) {
    console.error('Error reading transcript.txt:', err);
    res.status(500).json({ success: false, message: 'Could not read transcript file.' });
  }
});

const upload = multer(); // Use memory storage defined earlier

// ——— Summarize Endpoint ———
app.post('/summarize', upload.none(), async (req, res) => {
  try {
    const userId = req.body?.userId;
    const audioFileName = req.body?.audioFileName || 'Transcription';
    const mp3BaseName = audioFileName.replace(/\.[^/.]+$/, '');

    let transcript = req.body?.transcript;

    // Fallback: try reading from ./transcript.txt if transcript field is missing
    if (!transcript) {
      try {
        transcript = fs.readFileSync('./transcript.txt', 'utf-8');
        console.log('ℹ️ Loaded transcript from local file.');
      } catch (e) {
        return res.status(400).json({
          success: false,
          message: 'Transcript is missing and no fallback file was found.',
        });
      }
    }

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'Missing userId in request body.'
      });
    }

    // Templates for summarization
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
"${transcript}"`
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
"${transcript}"`
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
"${transcript}"`
      }
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

      const doc = new Document({
        creator: 'Smart Minutes App',
        title: `Minutes of the Meeting - ${template.name}`,
        description: 'Auto-generated summary of transcribed audio.',
        sections: [
          { children: summaryText.split('\n').map(line => new Paragraph(line)) },
        ],
      });

      const fileName = `${mp3BaseName}-${template.name}-${Date.now()}.docx`;
      const buffer = await Packer.toBuffer(doc);

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

      const driveRes = await drive.files.create({
        requestBody: fileMetadata,
        media,
        fields: 'id',
      });

      const fileId = driveRes.data.id;

      await drive.permissions.create({
        fileId,
        requestBody: { role: 'reader', type: 'anyone' },
      });

      const publicLink = `https://drive.google.com/file/d/${fileId}/view?usp=sharing`;

      summariesTable[template.dbField] = publicLink;

      results.push({
        template: template.name,
        link: publicLink,
      });

      console.log(`✅ Created and uploaded: ${template.name}`);
    }

    // Save summary links under the user in Firebase
    const tableRef = db.ref(`summaries/${userId}`).push();
    await tableRef.set({
      audioFileName,
      createdAt: admin.database.ServerValue.TIMESTAMP,
      ...summariesTable
    });

    res.json({
      success: true,
      message: 'All templates processed, uploaded to Google Drive, and saved under user.',
      results,
      tableRecordId: tableRef.key,
    });

  } catch (error) {
    console.error('❌ Error in /summarize:', error);
    res.status(500).json({
      success: false,
      message: 'Error during summarization or file handling.',
      error: error.message,
    });
  }
});


// Fetch summaries
app.get('/allminutes/:id', async (req, res) => {
  const userId = req.params.id;
  if (!userId) return res.status(400).json({ success: false, message: 'User ID required' });

  try {
    const snapshot = await db.ref(`summaries/${userId}`).once('value');
    const data = snapshot.val();
    const minutes = data ? Object.entries(data).map(([id, val]) => ({ summaryId: id, ...val })) : [];
    res.json({ success: true, minutes });
  } catch (e) {
    console.error('Fetch Error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// Start server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));






