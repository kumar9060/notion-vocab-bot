const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');

// Initialize Notion Client
const notion = new Client({
  auth: process.env.NOTION_TOKEN
});

// Parent page ID
const PARENT_PAGE_ID = process.env.NOTION_PARENT_PAGE_ID || '36801e3e-1cfa-8019-a9e0-fccb947f45f8';

// Helper to format date in IST
function getISTDateInfo() {
  const options = { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'long', day: 'numeric' };
  const formatter = new Intl.DateTimeFormat('en-IN', options);
  const formattedDate = formatter.format(new Date()); // e.g. "7 June 2026"
  
  // Also get day difference from reference date for word selection
  const refDate = new Date("2026-06-07T00:00:00+05:30");
  const todayISTStr = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
  const todayIST = new Date(todayISTStr);
  const diffTime = Math.abs(todayIST - refDate);
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
  
  return { formattedDate, diffDays };
}

// Generate rich text structure for a paragraph with bold label
function createLabeledParagraph(label, content) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [
        {
          type: 'text',
          text: { content: label + '\n' },
          annotations: { bold: true }
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
    const { formattedDate, diffDays } = getISTDateInfo();
    console.log(`Today's Date (IST): ${formattedDate}`);
    console.log(`Days elapsed since reference date: ${diffDays}`);

    // Load words database
    const wordsFilePath = path.join(__dirname, 'words.json');
    if (!fs.existsSync(wordsFilePath)) {
      throw new Error('words.json not found!');
    }
    const words = JSON.parse(fs.readFileSync(wordsFilePath, 'utf-8'));
    console.log(`Loaded ${words.length} words from database.`);

    // Select 10 words sequentially
    const startIndex = (diffDays * 10) % words.length;
    const selectedWords = [];
    for (let i = 0; i < 10; i++) {
      const wordIndex = (startIndex + i) % words.length;
      selectedWords.push({
        ...words[wordIndex],
        num: i + 1
      });
    }

    console.log('Selected words for today:', selectedWords.map(w => w.word).join(', '));

    // Construct Notion page children blocks
    const childrenBlocks = [];

    selectedWords.forEach(w => {
      // 1. Word Heading (H1)
      childrenBlocks.push({
        object: 'block',
        type: 'heading_1',
        heading_1: {
          rich_text: [
            {
              type: 'text',
              text: { content: `${w.num}. ${w.word}` }
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
                content: `Vocabulary - ${formattedDate}`
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

