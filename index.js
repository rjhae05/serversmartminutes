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
  console.log('Transcribe triggered');
  const { uid } = req.body;
  if (!req.file || !uid) return res.status(400).json({ success: false, message: 'File and UID required' });

  try {
    const original = req.file.originalname;
    const gcsFilename = `${Date.now()}-${original}`;
    const gcsUri = await uploadToGCS(req.file.buffer, gcsFilename);
    const rawTranscript = await transcribe(gcsUri);
    const cleaned = applyCorrections(rawTranscript);

    const timestamp = Date.now();
    const newRef = db.ref(`transcriptions/${uid}`).push();
    await newRef.set({ filename: original, text: cleaned, gcsUri, status: 'Completed', createdAt: timestamp });

    fs.writeFileSync('./transcript.txt', cleaned);
    console.log('Transcription done');

    res.json({ success: true, transcription: cleaned, audioFileName: original });
  } catch (e) {
    console.error('Transcription Error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// Summarize
app.post('/summarize', async (req, res) => {
  console.log('Summarize triggered');
  try {
    const transcript = fs.readFileSync('./transcript.txt', 'utf-8');
    const { audioFileName = 'Transcription', userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'userId required' });

    const base = audioFileName.replace(/\.[^/.]+$/, '');
    const templates = [
      { name: 'Formal', dbField: 'formal_template', prompt: `...formal spread...\n${transcript}` },
      { name: 'Simple', dbField: 'simple_template', prompt: `...simple bullet...\n${transcript}` },
      { name: 'Detailed', dbField: 'detailed_template', prompt: `...detailed MoM...\n${transcript}` },
    ];

    const results = {};
    const driveLinks = {};
    for (const t of templates) {
      const aiResponse = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [{ role: 'system', content: 'You format MoMs' }, { role: 'user', content: t.prompt }],
        temperature: 0.4
      });
      const summary = aiResponse.choices[0].message.content;

      const doc = new Document({
        creator: 'Smart Minutes',
        title: `${t.name} Minutes`,
        sections: [{ children: summary.split('\n').map(l => new Paragraph(l)) }],
      });
      const buffer = await Packer.toBuffer(doc);

      const Readable = require('stream').Readable;
      const stream = new Readable();
      stream.push(buffer);
      stream.push(null);

      const filename = `${base}-${t.name}-${Date.now()}.docx`;

      const { data } = await driveClient.files.create({
        requestBody: { name: filename, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', parents: [parentFolderId] },
        media: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body: stream },
        fields: 'id'
      });
      await driveClient.permissions.create({ fileId: data.id, requestBody: { role: 'reader', type: 'anyone' } });

      const link = `https://drive.google.com/file/d/${data.id}/view?usp=sharing`;
      driveLinks[t.dbField] = link;
      results[t.name] = link;
    }

    await db.ref(`summaries/${userId}`).push({ audioFileName, createdAt: admin.database.ServerValue.TIMESTAMP, ...driveLinks });

    res.json({ success: true, results });
  } catch (e) {
    console.error('Summarize Error:', e);
    res.status(500).json({ success: false, message: e.message });
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
