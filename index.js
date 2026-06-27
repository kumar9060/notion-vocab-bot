const { Client } = require('@notionhq/client');
const https = require('https');

// Initialize Notion Client
const notion = new Client({
  auth: process.env.NOTION_TOKEN
});

// Parent page ID
const PARENT_PAGE_ID = process.env.NOTION_PARENT_PAGE_ID || '36801e3e-1cfa-8019-a9e0-fccb947f45f8';
const WEEKLY_PARENT_PAGE_ID = process.env.NOTION_WEEKLY_PARENT_PAGE_ID || '36801e3e-1cfa-8072-9f1b-c74fd7a4e2c9';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AQ.Ab8RN6LlKx7lBcOIXoZp9EioI4ZIUIZ2_8yu04WGEXnu7gm3Og';

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

// Helper to sleep for ms
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper to make POST request to Gemini API with exponential backoff retry logic and dynamic model fallback
let activeModel = GEMINI_MODEL;
const MODEL_FALLBACKS = ['gemini-2.5-flash-lite', 'gemini-3.5-flash', 'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash-lite', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest'];

async function callGemini(payload, retries = 7, delay = 4000) {
  let currentDelay = delay;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const postData = JSON.stringify(payload);
        const options = {
          hostname: 'generativelanguage.googleapis.com',
          path: `/v1beta/models/${activeModel}:generateContent?key=${GEMINI_API_KEY}`,
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
      if (error.statusCode === 429 && error.body) {
        try {
          const errObj = JSON.parse(error.body);
          const quotaFailure = errObj.error?.details?.find(d => d['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure');
          const isDailyLimit = quotaFailure?.violations?.some(v => v.quotaId?.includes('PerDay')) || 
                               errObj.error?.message?.includes('quota');
          if (isDailyLimit) {
            const currentIdx = MODEL_FALLBACKS.indexOf(activeModel);
            const nextModel = MODEL_FALLBACKS[currentIdx + 1];
            if (nextModel) {
              console.warn(`⚠️ Daily quota exceeded for model "${activeModel}". Switching to fallback model "${nextModel}"...`);
              activeModel = nextModel;
              attempt = 0; // Reset attempts to start fresh with new model
              currentDelay = delay;
              continue;
            }
          }
        } catch (e) {
          // Ignore parsing error
        }
      }

      const isTemporary = error.statusCode === 503 || error.statusCode === 429 || !error.statusCode;
      if (isTemporary && attempt < retries) {
        let sleepDelay = currentDelay;
        if (error.statusCode === 429 && error.body) {
          try {
            const errObj = JSON.parse(error.body);
            const retryInfo = errObj.error?.details?.find(d => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
            if (retryInfo && retryInfo.retryDelay) {
              const delaySec = parseFloat(retryInfo.retryDelay);
              if (!isNaN(delaySec)) {
                sleepDelay = Math.ceil(delaySec + 2) * 1000; // Add 2 seconds safety buffer
                console.warn(`Gemini API 429 Rate Limit: Dynamic backoff requested for ${delaySec}s. Safety sleeping for ${sleepDelay}ms...`);
              }
            }
          } catch (e) {
            // Ignore parsing error
          }
        }
        console.warn(`Gemini API error (Status: ${error.statusCode || 'Network'}). Retrying in ${sleepDelay}ms... (Attempt ${attempt}/${retries})`);
        await sleep(sleepDelay);
        currentDelay *= 2; // Exponential backoff for next time
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

// Generate rich text structure for a paragraph with bold and italic label (no underline) on the same line
function createBoldItalicParagraph(label, content) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [
        {
          type: 'text',
          text: { content: label + ' ' },
          annotations: { bold: true, italic: true }
        },
        {
          type: 'text',
          text: { content: content || 'N/A' }
        }
      ]
    }
  };
}

// Helper to format weekly date range in IST (e.g. "22 - 27 Jun" or "29 Jun - 04 Jul")
function getWeeklyDateRange() {
  const todayISTStr = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
  const today = new Date(todayISTStr);
  
  // Monday is 6 days ago
  const monday = new Date(today);
  monday.setDate(today.getDate() - 6);
  
  // Saturday is 1 day ago
  const saturday = new Date(today);
  saturday.setDate(today.getDate() - 1);
  
  const shortMonth = (date) => date.toLocaleString('en-US', { month: 'short', timeZone: 'Asia/Kolkata' });
  const padZero = (num) => num.toString().padStart(2, '0');
  
  const monDay = padZero(monday.getDate());
  const satDay = padZero(saturday.getDate());
  const monMonth = shortMonth(monday);
  const satMonth = shortMonth(saturday);
  
  if (monMonth === satMonth) {
    return `${monDay} - ${satDay} ${monMonth}`;
  } else {
    return `${monDay} ${monMonth} - ${satDay} ${satMonth}`;
  }
}

// Generic page creator to dynamically handle database vs page parent types
async function createNotionPage(parentId, titleText) {
  console.log(`Detecting parent type and title column name for parent ID: ${parentId}...`);
  let parentParam = {};
  let propertiesParam = {};
  try {
    console.log(`Checking if parent ID ${parentId} is a database...`);
    const dbInfo = await notion.databases.retrieve({ database_id: parentId });
    const titleColName = (dbInfo.properties && Object.keys(dbInfo.properties).find(k => dbInfo.properties[k].type === 'title')) || 'Page';
    console.log(`Parent is a Database. Title column name: "${titleColName}"`);
    
    parentParam = { database_id: parentId };
    propertiesParam[titleColName] = {
      title: [
        {
          text: {
            content: titleText
          }
        }
      ]
    };
  } catch (dbError) {
    console.log(`Not a database or error retrieving: ${dbError.message}. Assuming page parent.`);
    parentParam = { page_id: parentId };
    propertiesParam = {
      title: {
        title: [
          {
            text: {
              content: titleText
            }
          }
        ]
      }
    };
  }

  console.log('Sending request to Notion to create child page...');
  const newPage = await notion.pages.create({
    parent: parentParam,
    properties: propertiesParam
  });
  return newPage;
}

// Generate rich text structure for a daily paragraph with bold, italic, and underlined label
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
    console.log(`Debug - Parent Page ID: "${PARENT_PAGE_ID}"`);
    console.log(`Debug - Notion Token length: ${process.env.NOTION_TOKEN ? process.env.NOTION_TOKEN.length : 0}`);
    console.log(`Debug - Notion Token prefix: "${process.env.NOTION_TOKEN ? process.env.NOTION_TOKEN.substring(0, 10) : 'none'}"`);

    if (!GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY environment variable is not defined.');
    }

    // ==========================================
    // STEP 1: Fetch 10 words from The Hindu editorials
    // ==========================================
    console.log('Step 1: Searching for The Hindu editorial words in the last 24 hours (UPSC focus)...');
    
    const searchPrompt = `SYSTEM INSTRUCTION: You are a strict text parser. Do NOT write sentences, introductions, explanations, apologies, or warnings. You must output exactly 10 words separated by commas and nothing else. Ensure correct English spelling for every word (do NOT output misspelled words). Avoid common or basic words (such as "auspicious", "preparedness", "loopholes"). Focus strictly on high-utility administrative, governance, socio-economic, policy, international relations, or ethical vocabulary (e.g., "hegemony", "ameliorate", "pernicious", "paradigm", "efficacy", "obfuscate", "draconian", "impunity", "defection").
Identify 10 important, challenging, and UPSC-oriented vocabulary words from The Hindu articles or editorials on ${formattedDate} or ${yesterdayFormattedDate}.
Output format: word1, word2, word3, word4, word5, word6, word7, word8, word9, word10`;

    const step1Payload = {
      contents: [{
        parts: [{ text: searchPrompt }]
      }],
      tools: [{ google_search: {} }]
    };

    let rawWordsText;
    let wordsList = [];
    try {
      const step1Result = await callGemini(step1Payload);
      rawWordsText = step1Result?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (rawWordsText) {
        wordsList = rawWordsText
          .replace(/[*\n#]/g, '')
          .split(',')
          .map(w => w.trim())
          .filter(w => w.length > 0 && !w.includes(' '));
      }
    } catch (e) {
      console.warn(`Search-based word retrieval failed: ${e.message}. Using fallback model call...`);
    }

    if (wordsList.length < 5) {
      console.log('Falling back to direct UPSC word generation (no search tool)...');
      const fallbackPrompt = `SYSTEM INSTRUCTION: You are a strict text parser. Do NOT write sentences, introductions, explanations, apologies, or warnings. You must output exactly 10 words separated by commas and nothing else. Ensure correct English spelling for every word (do NOT output misspelled words). Avoid common or basic words (such as "auspicious", "preparedness", "loopholes"). Focus strictly on high-utility administrative, governance, socio-economic, policy, international relations, or ethical vocabulary (e.g., "hegemony", "ameliorate", "pernicious", "paradigm", "efficacy", "obfuscate", "draconian", "impunity", "defection").
Identify 10 important, challenging, and UPSC-oriented vocabulary words typical of The Hindu editorial articles.
Output format: word1, word2, word3, word4, word5, word6, word7, word8, word9, word10`;
      const fallbackPayload = {
        contents: [{
          parts: [{ text: fallbackPrompt }]
        }]
      };
      const fallbackResult = await callGemini(fallbackPayload);
      const fallbackText = fallbackResult?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!fallbackText) {
        throw new Error('Failed to retrieve vocabulary list from fallback Gemini generation.');
      }
      wordsList = fallbackText
        .replace(/[*\n#]/g, '')
        .split(',')
        .map(w => w.trim())
        .filter(w => w.length > 0 && !w.includes(' '));
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
- pronunciation (English phonetic respelling and Hindi Devanagari script, e.g., "im-pol-i-tik (इम्पॉलिटिक)" or "per-nish-uhs (पर्निशस)". Ensure the Devanagari transliteration is extremely accurate according to the correct English pronunciation.)
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

    // Automatically find or create the Month page under PARENT_PAGE_ID
    const currentMonthName = new Date().toLocaleString("en-US", { month: "long", timeZone: "Asia/Kolkata" });
    console.log(`Locating month page "${currentMonthName}" under parent ID: ${PARENT_PAGE_ID}...`);
    
    let monthPageId = PARENT_PAGE_ID;
    try {
      const searchResponse = await notion.search({
        query: currentMonthName,
        page_size: 20,
        filter: { value: 'page', property: 'object' }
      });
      
      const foundMonthPage = searchResponse.results.find(page => {
        const title = page.properties?.Page?.title?.[0]?.plain_text || page.properties?.title?.title?.[0]?.plain_text || '';
        const isTitleMatch = title.trim().toLowerCase() === currentMonthName.toLowerCase();
        const isParentMatch = page.parent?.database_id === PARENT_PAGE_ID || page.parent?.page_id === PARENT_PAGE_ID;
        return isTitleMatch && isParentMatch;
      });

      if (foundMonthPage) {
        monthPageId = foundMonthPage.id;
        console.log(`Found month page "${currentMonthName}" (ID: ${monthPageId})`);
      } else {
        console.log(`Month page "${currentMonthName}" not found. Creating a new one under parent...`);
        const newMonthPage = await createNotionPage(PARENT_PAGE_ID, currentMonthName);
        monthPageId = newMonthPage.id;
        console.log(`Created new month page "${currentMonthName}" (ID: ${monthPageId})`);
      }
    } catch (searchError) {
      console.warn(`Warning searching/creating month page: ${searchError.message}. Falling back directly to PARENT_PAGE_ID.`);
    }

    // Create a new sub-page under the resolved month parent page/database (empty initially)
    const newPage = await createNotionPage(monthPageId, pageTitleDate);
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

    console.log(`✅ Success! Created new daily page: ${newPage.url}`);

    // Check if today is Sunday (IST) to run weekly compilation
    const todayISTStr = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    const todayIST = new Date(todayISTStr);
    if (todayIST.getDay() === 0) { // 0 = Sunday
      console.log('Today is Sunday! Starting Weekly Revision generation...');
      await runWeeklyRevision();
    }
  } catch (error) {
    console.error('❌ Error executing automation:', error);
    process.exit(1);
  }
}

async function runWeeklyRevision() {
  try {
    const weeklyTitle = getWeeklyDateRange();
    console.log(`Starting weekly compilation. Page Title: "${weeklyTitle}"`);

    // ==========================================
    // STEP 1: Fetch 20 weekly words
    // ==========================================
    console.log('Fetching 20 weekly vocabulary words (UPSC focus)...');
    const weeklySearchPrompt = `SYSTEM INSTRUCTION: You are a strict text parser. Do NOT write sentences, introductions, explanations, apologies, or warnings. You must output exactly 20 words separated by commas and nothing else. Ensure correct English spelling for every word (do NOT output misspelled words). Avoid common or basic words (such as "auspicious", "preparedness", "loopholes"). Focus strictly on high-utility administrative, governance, socio-economic, policy, international relations, or ethical vocabulary (e.g., "hegemony", "ameliorate", "pernicious", "paradigm", "efficacy", "obfuscate", "draconian", "impunity", "defection").
Identify the 20 most important, challenging, and UPSC-oriented vocabulary words that appeared in The Hindu editorials or articles in the last 7 days.
Output format: word1, word2, word3, ..., word20`;

    const weeklyPayload = {
      contents: [{
        parts: [{ text: weeklySearchPrompt }]
      }],
      tools: [{ google_search: {} }]
    };

    let weeklyWordsList = [];
    try {
      const result = await callGemini(weeklyPayload);
      const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        weeklyWordsList = text
          .replace(/[*\n#]/g, '')
          .split(',')
          .map(w => w.trim())
          .filter(w => w.length > 0 && !w.includes(' '));
      }
    } catch (e) {
      console.warn(`Weekly search failed: ${e.message}. Using fallback...`);
    }

    if (weeklyWordsList.length < 10) {
      console.log('Falling back to direct weekly word generation (no search)...');
      const fallbackWeeklyPrompt = `SYSTEM INSTRUCTION: You are a strict text parser. Do NOT write sentences. You must output exactly 20 words separated by commas and nothing else. Ensure correct English spelling for every word (do NOT output misspelled words). Avoid common or basic words (such as "auspicious", "preparedness", "loopholes"). Focus strictly on high-utility administrative, governance, socio-economic, policy, international relations, or ethical vocabulary (e.g., "hegemony", "ameliorate", "pernicious", "paradigm", "efficacy", "obfuscate", "draconian", "impunity", "defection").
Generate 20 challenging, UPSC-oriented vocabulary words typical of The Hindu editorials relevant to governance, economics, polity, ethics, and social issues.
Output format: word1, word2, ..., word20`;
      const fallbackResult = await callGemini({
        contents: [{ parts: [{ text: fallbackWeeklyPrompt }] }]
      });
      const text = fallbackResult?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error('Failed to generate weekly words fallback.');
      }
      weeklyWordsList = text
        .replace(/[*\n#]/g, '')
        .split(',')
        .map(w => w.trim())
        .filter(w => w.length > 0 && !w.includes(' '));
    }

    console.log(`Successfully identified ${weeklyWordsList.length} weekly words:`, weeklyWordsList.join(', '));

    // ==========================================
    // STEP 2: Generate detailed profiles in JSON (in batches of 5)
    // ==========================================
    console.log('Generating detailed profiles for weekly words in batches of 5...');
    const processedWeekly = [];
    const batchSize = 5;

    for (let i = 0; i < weeklyWordsList.length; i += batchSize) {
      const batch = weeklyWordsList.slice(i, i + batchSize);
      console.log(`Generating details for weekly batch ${i / batchSize + 1}: ${batch.join(', ')}`);
      
      const detailPrompt = `For the following vocabulary words: ${batch.join(', ')}. Generate a detailed educational vocabulary profile suitable for UPSC preparation. Each word must have complete details. 
Return the output strictly as a JSON array matching the required schema. Ensure the fields exactly match:
- word
- pronunciation (English phonetic respelling and Hindi Devanagari script, e.g., "im-pol-i-tik (इम्पॉलिटिक)" or "per-nish-uhs (पर्निशस)". Ensure the Devanagari transliteration is extremely accurate according to the correct English pronunciation.)
- part_of_speech (e.g. Noun/Verb/Adjective)
- hindi_meaning (precise translation, e.g. "अविवेकपूर्ण, अदूरदर्शी")
- english_definition (clear and simple definition)
- synonyms (comma-separated list of 3-4 words)
- antonyms (comma-separated list of 3-4 words)
- related_terms (comma-separated list of 2-3 related forms maximum, e.g. "impunity, impunitive")
- example_sentence (contextual sentence)
- upsc_usage (specific guidelines on how to use it in answers)
- editorial_relevance (how it commonly appears in editorials)
- mnemonic (easy memory trick)
- etymology (origin of the word)
- tone (Positive / Negative / Neutral etc.)`;

      const payload = {
        contents: [{ parts: [{ text: detailPrompt }] }],
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
                related_terms: { type: "STRING", description: "comma-separated list of 2-3 related forms maximum" }
              },
              required: ["word", "pronunciation", "part_of_speech", "hindi_meaning", "english_definition", "synonyms", "antonyms", "related_terms"]
            }
          }
        }
      };

      const result = await callGemini(payload);
      const jsonText = result?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!jsonText) {
        throw new Error(`Failed to retrieve weekly detailed profiles for batch ${batch.join(', ')}`);
      }

      try {
        const batchResults = JSON.parse(jsonText);
        processedWeekly.push(...batchResults);
      } catch (err) {
        throw new Error(`Failed to parse weekly batch JSON. Raw: ${jsonText}. Error: ${err.message}`);
      }

      if (i + batchSize < weeklyWordsList.length) {
        console.log('Waiting 2 seconds before the next weekly batch...');
        await sleep(2000);
      }
    }

    console.log(`Total weekly words processed: ${processedWeekly.length}`);

    // ==========================================
    // STEP 3: Format and upload weekly to Notion
    // ==========================================
    const weeklyBlocks = [];
    processedWeekly.forEach((w, index) => {
      // 1. Heading 2 for Word
      weeklyBlocks.push({
        object: 'block',
        type: 'heading_2',
        heading_2: {
          rich_text: [{ type: 'text', text: { content: `${index + 1}. ${w.word.charAt(0).toUpperCase() + w.word.slice(1)}` } }]
        }
      });

      // 2. Table: Pronunciation, Part of Speech, Hindi Meaning
      weeklyBlocks.push({
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

      // 3. Simple English definition (labeled paragraph with bold, italic, and underlined label)
      weeklyBlocks.push(createLabeledParagraph('Simple English definition:', w.english_definition));

      // 4. Table: Synonyms, Antonyms, Related Terms
      weeklyBlocks.push({
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

      // Divider between weekly words
      weeklyBlocks.push({
        object: 'block',
        type: 'divider',
        divider: {}
      });
    });

    // Automatically find or create the Month page under WEEKLY_PARENT_PAGE_ID
    const satDateISTStr = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    const satDateIST = new Date(satDateISTStr);
    const currentDay = satDateIST.getDay();
    const daysToSubtract = currentDay === 0 ? 1 : (currentDay === 6 ? 0 : currentDay + 1);
    satDateIST.setDate(satDateIST.getDate() - daysToSubtract);
    const currentMonthName = satDateIST.toLocaleString("en-US", { month: "long", timeZone: "Asia/Kolkata" });

    console.log(`Locating weekly month page "${currentMonthName}" under parent ID: ${WEEKLY_PARENT_PAGE_ID}...`);
    
    let weeklyMonthPageId = WEEKLY_PARENT_PAGE_ID;
    try {
      const searchResponse = await notion.search({
        query: currentMonthName,
        page_size: 20,
        filter: { value: 'page', property: 'object' }
      });
      
      const foundMonthPage = searchResponse.results.find(page => {
        const title = page.properties?.Page?.title?.[0]?.plain_text || page.properties?.title?.title?.[0]?.plain_text || '';
        const isTitleMatch = title.trim().toLowerCase() === currentMonthName.toLowerCase();
        const isParentMatch = page.parent?.database_id === WEEKLY_PARENT_PAGE_ID || page.parent?.page_id === WEEKLY_PARENT_PAGE_ID;
        return isTitleMatch && isParentMatch;
      });

      if (foundMonthPage) {
        weeklyMonthPageId = foundMonthPage.id;
        console.log(`Found weekly month page "${currentMonthName}" (ID: ${weeklyMonthPageId})`);
      } else {
        console.log(`Weekly month page "${currentMonthName}" not found. Creating a new one under parent...`);
        const newMonthPage = await createNotionPage(WEEKLY_PARENT_PAGE_ID, currentMonthName);
        weeklyMonthPageId = newMonthPage.id;
        console.log(`Created new weekly month page "${currentMonthName}" (ID: ${weeklyMonthPageId})`);
      }
    } catch (searchError) {
      console.warn(`Warning searching/creating weekly month page: ${searchError.message}. Falling back directly to WEEKLY_PARENT_PAGE_ID.`);
    }

    const weeklyPage = await createNotionPage(weeklyMonthPageId, weeklyTitle);
    console.log(`Weekly Page created. ID: ${weeklyPage.id}`);

    console.log(`Appending ${weeklyBlocks.length} weekly blocks in chunks...`);
    const chunkSize = 25; // 5 words * 5 blocks/word = 25 blocks
    for (let i = 0; i < weeklyBlocks.length; i += chunkSize) {
      const chunk = weeklyBlocks.slice(i, i + chunkSize);
      await notion.blocks.children.append({
        block_id: weeklyPage.id,
        children: chunk
      });
      console.log(`Appended weekly blocks ${i} to ${Math.min(i + chunkSize, weeklyBlocks.length)}`);
    }

    console.log(`✅ Success! Created new Weekly Revision page: ${weeklyPage.url}`);
  } catch (weeklyError) {
    console.error('❌ Error executing weekly compilation:', weeklyError);
  }
}

run();
