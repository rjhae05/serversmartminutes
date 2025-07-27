# Speech-to-Text Transcription with Google Cloud API

This Node.js application demonstrates how to transcribe audio files using the Google Cloud Speech-to-Text API. It reads an audio file, sends it to the API for transcription, and displays the transcribed text.

## Prerequisites

Before running this application, you need to have the following:

- [Node.js](https://nodejs.org/) installed on your machine.
- A Google Cloud Platform (GCP) project with the Speech-to-Text API enabled.
- A service account key JSON file for authentication. Set the path to this file in the `GOOGLE_APPLICATION_CREDENTIALS` environment variable.

## Installation

1. Clone this repository to your local machine:

   ```shell
   git clone https://github.com/adanzweig/nodejs-googlestt.git
   cd nodejs-googlestt
   ```

2. Install the project dependencies:

   ```shell
   npm install
   ```

## Usage

1. Place the audio file you want to transcribe in the project directory. Ensure that the file format is compatible with the Google Cloud Speech-to-Text API.

2. Modify the `config` object in the `transcribeAudio` function in `index.js` if needed. You may need to adjust the `encoding`, `sampleRateHertz`, and `languageCode` properties to match your audio file.

3. Run the application:

   ```shell
   node index.js
   ```

   The application will transcribe the audio and display the transcribed text in the console.

## Example

Here's an example of running the application:

```shell
$ node index.js

Transcription result:
This is an example of a transcribed audio file using the Google Cloud Speech-to-Text API.
```

## Troubleshooting

If you encounter any issues or errors while running the application, please refer to the [troubleshooting section](#troubleshooting) in this README or seek assistance on the [Google Cloud Community Forums](https://cloud.google.com/community).