const { Client } = require('@notionhq/client');
const https = require('https');

// Initialize Notion Client
const notion = new Client({
  auth: process.env.NOTION_TOKEN
});

// Parent page ID
const PARENT_PAGE_ID = process.env.NOTION_PARENT_PAGE_ID || '36801e3e-1cfa-8019-a9e0-fccb947f45f8';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AQ.Ab8RN6LlKx7lBcOIXoZp9EioI4ZIUIZ2_8yu04WGEXnu7gm3Og';

// Helper to sleep for ms
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper to make POST request to Gemini API with exponential backoff retry logic
async function callGemini(payload, retries = 5, delay = 3000) {
  let currentDelay = delay;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const postData = JSON.stringify(payload);
        const options = {
          hostname: 'generativelanguage.googleapis.com',
          path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          }
        };

        const req = https.request(options, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(body));
              } catch (e) {
                reject(new Error(`Failed to parse response JSON: ${e.message}. Raw: ${body}`));
              }
            } else {
              reject({ statusCode: res.statusCode, body });
            }
          });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
      });
    } catch (error) {
      const isTemporary = error.statusCode === 503 || error.statusCode === 429 || !error.statusCode;
      if (isTemporary && attempt < retries) {
        console.warn(`Gemini API error (Status: ${error.statusCode || 'Network'}). Retrying in ${currentDelay}ms... (Attempt ${attempt}/${retries})`);
        await sleep(currentDelay);
        currentDelay *= 2; // Exponential backoff
        continue;
      }
      throw new Error(error.body ? `API Error status ${error.statusCode}: ${error.body}` : error.message || error);
    }
  }
}

// Helper to format date in IST
function getISTDateInfo() {
  const fullOptions = { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'long', day: 'numeric' };
  const shortOptions = { timeZone: 'Asia/Kolkata', month: 'long', day: 'numeric' };
  
  const fullFormatter = new Intl.DateTimeFormat('en-IN', fullOptions);
  const shortFormatter = new Intl.DateTimeFormat('en-IN', shortOptions);
  
  const formattedDate = fullFormatter.format(new Date()); // e.g. "7 June 2026"
  const pageTitleDate = shortFormatter.format(new Date()); // e.g. "7 June"
  
  const todayISTStr = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
  const today = new Date(todayISTStr);
  
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const yesterdayFormattedDate = fullFormatter.format(yesterday);
  
  return { formattedDate, yesterdayFormattedDate, pageTitleDate };
}

// Generate rich text structure for a paragraph with bold, italic, and underlined label
function createLabeledParagraph(label, content) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [
        {
          type: 'text',
          text: { content: label + '\n' },
          annotations: { bold: true, italic: true, underline: true }
        },
        {
          type: 'text',
          text: { content: content || 'N/A' }
        }
      ]
    }
  };
}

async function run() {
  try {
    const { formattedDate, yesterdayFormattedDate, pageTitleDate } = getISTDateInfo();
    console.log(`Current Date (IST): ${formattedDate}`);
    console.log(`Yesterday's Date (IST): ${yesterdayFormattedDate}`);
    console.log(`Notion Page Title Date: ${pageTitleDate}`);

    if (!GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY environment variable is not defined.');
    }

    // ==========================================
    // STEP 1: Fetch 10 words from The Hindu editorials
    // ==========================================
    console.log('Step 1: Searching for The Hindu editorial words in the last 24 hours (UPSC focus)...');
    
    const searchPrompt = `SYSTEM INSTRUCTION: You are a strict text parser. Do NOT write sentences, introductions, explanations, apologies, or warnings about web access limitations. You must output exactly 10 words separated by commas and nothing else. If search results for the specific day are paywalled or thin, use your knowledge of current news topics to select 10 high-frequency, challenging UPSC vocabulary words relevant to today.

Identify 10 important, challenging, and UPSC-oriented vocabulary words (words relevant to administrative, governance, socio-economic, policy, international relations, or ethical discussions in civil services prep) from The Hindu articles or editorials on ${formattedDate} or ${yesterdayFormattedDate}.
Output format: word1, word2, word3, word4, word5, word6, word7, word8, word9, word10`;

    const step1Payload = {
      contents: [{
        parts: [{ text: searchPrompt }]
      }],
      tools: [{ google_search: {} }]
    };

    const step1Result = await callGemini(step1Payload);
    const rawWordsText = step1Result?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawWordsText) {
      throw new Error('Failed to retrieve vocabulary list from Gemini Search.');
    }

    console.log(`Raw search response: ${rawWordsText.trim()}`);
    // Clean and split the words
    const wordsList = rawWordsText
      .replace(/[*\n#]/g, '') // remove any stray formatting
      .split(',')
      .map(w => w.trim())
      .filter(w => w.length > 0);

    if (wordsList.length < 5) {
      throw new Error(`Retrieved too few words: ${JSON.stringify(wordsList)}`);
    }

    console.log(`Successfully identified ${wordsList.length} words:`, wordsList.join(', '));

    // ==========================================
    // STEP 2: Generate detailed profiles in JSON (in batches of 5)
    // ==========================================
    console.log('Step 2: Generating detailed UPSC profiles for the words in batches of 5...');
    
    const processedWords = [];
    const batchSize = 5;

    for (let i = 0; i < wordsList.length; i += batchSize) {
      const batch = wordsList.slice(i, i + batchSize);
      console.log(`Generating details for batch ${i / batchSize + 1}: ${batch.join(', ')}`);
      
      const detailPrompt = `For the following vocabulary words: ${batch.join(', ')}. Generate a detailed educational vocabulary profile suitable for UPSC preparation. Each word must have complete details. 
Return the output strictly as a JSON array matching the required schema. Ensure the fields exactly match:
- word
- pronunciation (English IPA, e.g. /ˌæk.rɪˈmoʊ.ni.əs/)
- part_of_speech (e.g. Noun/Verb/Adjective)
- hindi_meaning (precise translation, e.g. "उग्र, कटुतापूर्ण")
- english_definition (clear and simple definition)
- synonyms (comma-separated list of 3-4 words)
- antonyms (comma-separated list of 3-4 words)
- related_terms (comma-separated list of related forms, e.g. acrimony, acrimoniously)
- example_sentence (contextual sentence, preferably related to governance, society, economy, ethics, polity, etc.)
- upsc_usage (specific guidelines on how to use it in GS, Essay, Ethics, or Interview answers)
- editorial_relevance (how it commonly appears in newspapers and editorials)
- mnemonic (easy memory trick)
- etymology (origin and historical development of the word)
- tone (Positive / Negative / Neutral / Formal / Informal / Critical / Appreciative etc.)`;

      const step2Payload = {
        contents: [{
          parts: [{ text: detailPrompt }]
        }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                word: { type: "STRING" },
                pronunciation: { type: "STRING" },
                part_of_speech: { type: "STRING" },
                hindi_meaning: { type: "STRING" },
                english_definition: { type: "STRING" },
                synonyms: { type: "STRING" },
                antonyms: { type: "STRING" },
                related_terms: { type: "STRING" },
                example_sentence: { type: "STRING" },
                upsc_usage: { type: "STRING" },
                editorial_relevance: { type: "STRING" },
                mnemonic: { type: "STRING" },
                etymology: { type: "STRING" },
                tone: { type: "STRING" }
              },
              required: [
                "word", "pronunciation", "part_of_speech", "hindi_meaning", 
                "english_definition", "synonyms", "antonyms", "related_terms", 
                "example_sentence", "upsc_usage", "editorial_relevance", 
                "mnemonic", "etymology", "tone"
              ]
            }
          }
        }
      };

      const step2Result = await callGemini(step2Payload);
      const rawJsonText = step2Result?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawJsonText) {
        throw new Error(`Failed to retrieve detailed profiles for batch ${batch.join(', ')}`);
      }

      try {
        const batchResults = JSON.parse(rawJsonText);
        processedWords.push(...batchResults);
        console.log(`Successfully processed batch ${i / batchSize + 1}.`);
      } catch (err) {
        throw new Error(`Failed to parse batch JSON. Raw: ${rawJsonText}. Error: ${err.message}`);
      }

      // Small delay between batch calls to prevent rate limits
      if (i + batchSize < wordsList.length) {
        console.log('Waiting 2 seconds before the next batch...');
        await sleep(2000);
      }
    }

    console.log(`Total words processed: ${processedWords.length}`);

    // ==========================================
    // STEP 3: Format and upload to Notion
    // ==========================================
    const childrenBlocks = [];

    processedWords.forEach((w, index) => {
      // 1. Word Heading (H1)
      childrenBlocks.push({
        object: 'block',
        type: 'heading_1',
        heading_1: {
          rich_text: [
            {
              type: 'text',
              text: { content: `${index + 1}. ${w.word}` }
            }
          ]
        }
      });

      // 2. Table: Pronunciation, Part of Speech, Hindi Meaning
      childrenBlocks.push({
        object: 'block',
        type: 'table',
        table: {
          table_width: 3,
          has_column_header: true,
          has_row_header: false,
          children: [
            {
              object: 'block',
              type: 'table_row',
              table_row: {
                cells: [
                  [{ type: 'text', text: { content: 'Pronunciation' }, annotations: { bold: true } }],
                  [{ type: 'text', text: { content: 'Part of speech' }, annotations: { bold: true } }],
                  [{ type: 'text', text: { content: 'Hindi meaning' }, annotations: { bold: true } }]
                ]
              }
            },
            {
              object: 'block',
              type: 'table_row',
              table_row: {
                cells: [
                  [{ type: 'text', text: { content: w.pronunciation || '' } }],
                  [{ type: 'text', text: { content: w.part_of_speech || '' } }],
                  [{ type: 'text', text: { content: w.hindi_meaning || '' } }]
                ]
              }
            }
          ]
        }
      });

      // 3. Simple English definition
      childrenBlocks.push(createLabeledParagraph('Simple English definition:', w.english_definition));

      // 4. Table: Synonyms, Antonyms, Related Terms
      childrenBlocks.push({
        object: 'block',
        type: 'table',
        table: {
          table_width: 3,
          has_column_header: true,
          has_row_header: false,
          children: [
            {
              object: 'block',
              type: 'table_row',
              table_row: {
                cells: [
                  [{ type: 'text', text: { content: 'Synonyms' }, annotations: { bold: true } }],
                  [{ type: 'text', text: { content: 'Antonyms' }, annotations: { bold: true } }],
                  [{ type: 'text', text: { content: 'Related terms' }, annotations: { bold: true } }]
                ]
              }
            },
            {
              object: 'block',
              type: 'table_row',
              table_row: {
                cells: [
                  [{ type: 'text', text: { content: w.synonyms || '' } }],
                  [{ type: 'text', text: { content: w.antonyms || '' } }],
                  [{ type: 'text', text: { content: w.related_terms || '' } }]
                ]
              }
            }
          ]
        }
      });

      // 5. Example sentence
      childrenBlocks.push(createLabeledParagraph('Example sentence:', w.example_sentence));

      // 6. UPSC answer-writing usage
      childrenBlocks.push(createLabeledParagraph('UPSC answer-writing usage:', w.upsc_usage));

      // 7. Editorial relevance
      childrenBlocks.push(createLabeledParagraph('Editorial relevance:', w.editorial_relevance));

      // 8. Mnemonic
      childrenBlocks.push(createLabeledParagraph('Mnemonic:', w.mnemonic));

      // 9. Etymology (when relevant)
      if (w.etymology) {
        childrenBlocks.push(createLabeledParagraph('Etymology:', w.etymology));
      }

      // 10. Tone of the word
      childrenBlocks.push(createLabeledParagraph('Tone of the word:', w.tone));

      // Divider between words
      childrenBlocks.push({
        object: 'block',
        type: 'divider',
        divider: {}
      });
    });

    // Create a new sub-page under the Editorial parent page (empty initially)
    console.log('Sending request to Notion to create child page...');
    const newPage = await notion.pages.create({
      parent: {
        page_id: PARENT_PAGE_ID
      },
      properties: {
        title: {
          title: [
            {
              text: {
                content: pageTitleDate
              }
            }
          ]
        }
      }
    });

    console.log(`Page created. ID: ${newPage.id}`);
    console.log(`Appending ${childrenBlocks.length} blocks in chunks...`);

    // Notion API allows appending up to 100 blocks at a time.
    // We will append in chunks of 2 words at a time (about 20-22 blocks) to be very safe and fast.
    const chunkSize = 22; // 2 words * 11 blocks/word = 22 blocks
    for (let i = 0; i < childrenBlocks.length; i += chunkSize) {
      const chunk = childrenBlocks.slice(i, i + chunkSize);
      await notion.blocks.children.append({
        block_id: newPage.id,
        children: chunk
      });
      console.log(`Appended blocks ${i} to ${Math.min(i + chunkSize, childrenBlocks.length)}`);
    }

    console.log(`✅ Success! Created new page: ${newPage.url}`);
  } catch (error) {
    console.error('❌ Error executing automation:', error);
    process.exit(1);
  }
}

run();
