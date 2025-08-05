const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Storage } = require('@google-cloud/storage');
const speech = require('@google-cloud/speech').v1p1beta1;
const path = require('path');
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


const openaiKey = process.env.OPENAI_API_KEY;
const momKey = process.env.SMARTMINUTES_MOM_KEY;

const smartMinutesKey = process.env.SMART_MINUTES_KEY;

// ——— Google Cloud Config ———
const projectId = 'speech-to-text-459913';
const bucketName = 'smart-minutes-bucket';
const keyPath = smartMinutesKey;
process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;

const storage = new Storage({ projectId });
const speechClient = new speech.SpeechClient();
const openai = new OpenAI({ apiKey: openaiKey });

// ——— Multer Setup ———
const upload = multer({ storage: multer.memoryStorage() });

// ——— Google Drive Auth Setup ———
const auth = new google.auth.GoogleAuth({
  keyFile: momKey,
  scopes: ['https://www.googleapis.com/auth/drive'],
});

let drive; // drive client will be initialized
let parentFolderId = '1S1us2ikMWxmrfraOnHbAUNQqMSXywfbr'; // replace with your folder ID

(async () => {
  const authClient = await auth.getClient();
  drive = google.drive({ version: 'v3', auth: authClient });

  // Test folder access on start
  await testListFiles();
})();

// ——— Auto-correction Dictionary ———
const corrections = {
  'Thank you, sir. Have a good day in the': 'Thank you sa pag attend',
  'young': 'yoong',
  // Add more substitutions here
};

function applyCorrections(text) {
  for (const [wrong, correct] of Object.entries(corrections)) {
    const regex = new RegExp(`\\b${wrong}\\b`, 'gi');
    text = text.replace(regex, correct);
  }
  return text;
}


// ——— Test if service account can list files ———
async function testListFiles() {
  try {
    const res = await drive.files.list({
      q: `'${parentFolderId}' in parents`,
      fields: 'files(id, name)',
    });

    if (!res.data.files.length) {
      console.log('📂 Folder accessible but empty.');
    } else {
      console.log('✅ Folder accessible. Files:');
      res.data.files.forEach(file => console.log(`📄 ${file.name} (ID: ${file.id})`));
    }
  } catch (err) {
    console.error('❌ Cannot list files:', err.response?.data || err.message);
  }
}


// ——— Firebase Login ———
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const usersRef = db.ref('Users');

  try {
    const snapshot = await usersRef.once('value');
    const users = snapshot.val();

    for (const key in users) {
      if (users[key].email === email && users[key].password === password) {
        return res.status(200).json({ success: true, message: 'Login successful', uid: key });
      }
    }

    return res.status(401).json({ success: false, message: 'Invalid email or password' });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ——— Upload to GCS ———
async function uploadBufferToGCS(fileBuffer, gcsFileName) {
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(gcsFileName);

  await file.save(fileBuffer, {
    metadata: { contentType: 'audio/mpeg' },
    resumable: false,
  });

  console.log(`✅ Uploaded to gs://${bucketName}/${gcsFileName}`);
  return `gs://${bucketName}/${gcsFileName}`;
}

// ——— Transcription with Speaker Diarization ———
async function transcribeFromGCS(gcsUri) {
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

  const [operation] = await speechClient.longRunningRecognize(request);
  const [response] = await operation.promise();

  const result = response.results[response.results.length - 1];
  const wordsInfo = result.alternatives[0].words;

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

let audioFileName;
// ——— Transcribe Endpoint ———
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  const { uid } = req.body;

  if (!req.file || !uid) {
    return res.status(400).json({ success: false, message: 'Missing file or user ID' });
  }

  try {
    // ✅ Get original mp3 file name
    audioFileName = req.file.originalname;
   
    const gcsFileName = `${Date.now()}-${audioFileName}`;
    const gcsUri = await uploadBufferToGCS(req.file.buffer, gcsFileName);
    const transcript = await transcribeFromGCS(gcsUri);
    const cleanedTranscript = applyCorrections(transcript);

    const timestamp = Date.now();
    const newRef = db.ref(`transcriptions/${uid}`).push();
    await newRef.set({
      filename: audioFileName,       // ✅ store original filename
      text: cleanedTranscript,
      gcsUri,
      status: "✅ Transcription Complete",
      createdAt: timestamp,
    });

    // Save transcript locally
    fs.writeFileSync('./transcript.txt', cleanedTranscript);

    res.json({ 
      success: true, 
      transcription: cleanedTranscript,
      audioFileName: audioFileName   // ✅ include in response if frontend wants to save it
    });
  } catch (err) {
    console.error('❌ Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/*
// ——— Summarize Endpoint ———
app.post('/summarize', async (req, res) => {
  try {
    // Read transcript
    const transcript = fs.readFileSync('./transcript.txt', 'utf-8');

   audioFileName = req.body?.audioFileName || 'Transcription';
const mp3BaseName = audioFileName.replace(/\.[^/.]+$/, ""); // safely remove extension


    // Templates: do NOT change
    const templates = [
      {
        name: 'Template-Formal',
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
      }
    ];

    const results = [];

    for (const template of templates) {
      // 🧠 Get AI summary
      const aiResponse = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You are a helpful assistant who formats meeting transcriptions.' },
          { role: 'user', content: template.prompt },
        ],
        temperature: 0.4,
      });

      const summaryText = aiResponse.choices[0].message.content;

      // 📝 Create Word doc in memory
      const doc = new Document({
        creator: 'Smart Minutes App',
        title: `Minutes of the Meeting - ${template.name}`,
        description: 'Auto-generated summary of transcribed audio.',
        sections: [
          {
            children: summaryText.split('\n').map(line => new Paragraph(line)),
          },
        ],
      });

      // ✅ Create filename based on mp3 name and template
      const fileName = `${mp3BaseName}-${template.name}-${Date.now()}.docx`;

      // 📦 Generate buffer
      const buffer = await Packer.toBuffer(doc);

      // ☁️ Upload buffer directly to Google Drive
      const { Readable } = require('stream');
      const bufferStream = new Readable();
      bufferStream.push(buffer);
      bufferStream.push(null);

      const fileMetadata = {
        name: fileName,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        parents: [parentFolderId], // your Google Drive folder ID
      };

      const media = {
        mimeType: fileMetadata.mimeType,
        body: bufferStream,
      };

      const driveRes = await drive.files.create({
        requestBody: fileMetadata,
        media,
        fields: 'id',
      });

      const fileId = driveRes.data.id;

      // 🌍 Make file public
      await drive.permissions.create({
        fileId,
        requestBody: { role: 'reader', type: 'anyone' },
      });

      const publicLink = `https://drive.google.com/file/d/${fileId}/view?usp=sharing`;

      // 🔥 Save summary metadata to Firebase
      const summaryRef = db.ref('summaries').push();
      await summaryRef.set({
        fileId,
        link: publicLink,
        template: template.name,
        createdAt: admin.database.ServerValue.TIMESTAMP,
      });

      results.push({
        template: template.name,
        link: publicLink,
        actionNumber: summaryRef.key,
      });

      console.log(`✅ Created and uploaded: ${template.name}`);
    }

    res.json({
      success: true,
      message: 'All templates processed, uploaded to Google Drive, and recorded in Firebase.',
      results,
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

*/


// ——— Summarize Endpoint ———
app.post('/summarize', async (req, res) => {
  try {
    const transcript = fs.readFileSync('./transcript.txt', 'utf-8');
    const audioFileName = req.body?.audioFileName || 'Transcription';
    const mp3BaseName = audioFileName.replace(/\.[^/.]+$/, "");

    const userId = req.body?.userId;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'Missing userId in request body.'
      });
    }

    // Original, more complete prompts
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
    const summariesTable = {}; // Google Drive share links

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

    // ✅ Save under userId → summaryId
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


// ——— Fetch all minutes by userId ———
app.get('/allminutes/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'Missing user ID in URL parameter.'
      });
    }

    // Fetch summaries/{userId}
    const snapshot = await db.ref(`summaries/${userId}`).once('value');
    const data = snapshot.val();

    if (!data) {
      return res.json({
        success: true,
        message: 'No minutes of meeting found for this user.',
        minutes: []
      });
    }

    // Map to array, keep 3 template links
    const minutes = Object.entries(data).map(([summaryId, details]) => ({
      summaryId,
      audioFileName: details.audioFileName || 'Untitled',
      createdAt: details.createdAt || null,
      formal_template: details.formal_template || null,
      simple_template: details.simple_template || null,
      detailed_template: details.detailed_template || null,
    }));

    res.json({
      success: true,
      message: 'Minutes fetched successfully.',
      minutes
    });

  } catch (error) {
    console.error('❌ Error in /allminutes/:id:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch minutes.',
      error: error.message
    });
  }
});



// ——— Start Server ———
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
