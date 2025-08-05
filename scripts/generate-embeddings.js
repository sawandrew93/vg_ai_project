// scripts/generate-embeddings.js
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');

// Initialize clients
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function generateEmbedding(text) {
  try {
    const result = await embeddingModel.embedContent(text);
    return result.embedding.values;
  } catch (error) {
    console.error('Error generating embedding:', error);
    throw error;
  }
}

async function generateEmbeddingsForAllDocuments() {
  try {
    console.log('🚀 Starting embedding generation process...');

    // Fetch all documents without embeddings
    const { data: documents, error } = await supabase
      .from('documents')
      .select('id, content')
      .is('embedding', null);

    if (error) {
      throw error;
    }

    console.log(`📄 Found ${documents.length} documents without embeddings`);

    let processed = 0;
    let failed = 0;

    for (const doc of documents) {
      try {
        console.log(`🔄 Processing document ${doc.id}: "${doc.content.substring(0, 50)}..."`);

        // Generate embedding
        const embedding = await generateEmbedding(doc.content);

        // Update document with embedding
        const { error: updateError } = await supabase
          .from('documents')
          .update({ embedding })
          .eq('id', doc.id);

        if (updateError) {
          console.error(`❌ Failed to update document ${doc.id}:`, updateError);
          failed++;
        } else {
          console.log(`✅ Successfully updated document ${doc.id}`);
          processed++;
        }

        // Add a small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        console.error(`❌ Error processing document ${doc.id}:`, error);
        failed++;
      }
    }

    console.log(`\n🎉 Embedding generation complete!`);
    console.log(`✅ Successfully processed: ${processed} documents`);
    console.log(`❌ Failed: ${failed} documents`);
    console.log(`📊 Total: ${documents.length} documents`);

  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

async function testSimilaritySearch() {
  try {
    console.log('\n🔍 Testing similarity search...');

    const testQuery = "How much does the basic plan cost?";
    console.log(`Query: "${testQuery}"`);

    // Generate embedding for test query
    const queryEmbedding = await generateEmbedding(testQuery);

    // Search for similar documents
    const { data: results, error } = await supabase.rpc('match_documents', {
      query_embedding: queryEmbedding,
      match_threshold: 0.5,
      match_count: 3
    });

    if (error) {
      throw error;
    }

    console.log(`\n📊 Found ${results.length} similar documents:`);
    results.forEach((result, index) => {
      console.log(`\n${index + 1}. Similarity: ${(result.similarity * 100).toFixed(1)}%`);
      console.log(`   Content: "${result.content}"`);
      console.log(`   Metadata:`, result.metadata);
    });

  } catch (error) {
    console.error('❌ Error testing similarity search:', error);
  }
}

async function addCustomDocument(content, metadata = {}) {
  try {
    console.log(`\n📝 Adding custom document: "${content.substring(0, 50)}..."`);

    // Generate embedding
    const embedding = await generateEmbedding(content);

    // Insert document
    const { data, error } = await supabase
      .from('documents')
      .insert([{ content, metadata, embedding }])
      .select();

    if (error) {
      throw error;
    }

    console.log(`✅ Successfully added document with ID: ${data[0].id}`);
    return data[0];

  } catch (error) {
    console.error('❌ Error adding custom document:', error);
    throw error;
  }
}

// Command line interface
async function main() {
  const command = process.argv[2];

  switch (command) {
    case 'generate':
      await generateEmbeddingsForAllDocuments();
      break;

    case 'test':
      await testSimilaritySearch();
      break;

    case 'add':
      const content = process.argv[3];
      const metadataStr = process.argv[4];

      if (!content) {
        console.error('❌ Please provide content for the document');
        console.log('Usage: node scripts/generate-embeddings.js add "Your content here" \'{"category": "example"}\'');
        process.exit(1);
      }

      let metadata = {};
      if (metadataStr) {
        try {
          metadata = JSON.parse(metadataStr);
        } catch (error) {
          console.error('❌ Invalid JSON metadata:', error);
          process.exit(1);
        }
      }

      await addCustomDocument(content, metadata);
      break;

    case 'bulk-add':
      await bulkAddDocuments();
      break;

    default:
      console.log('📖 Usage:');
      console.log('  node scripts/generate-embeddings.js generate  - Generate embeddings for all documents');
      console.log('  node scripts/generate-embeddings.js test     - Test similarity search');
      console.log('  node scripts/generate-embeddings.js add "content" \'{"meta": "data"}\' - Add single document');
      console.log('  node scripts/generate-embeddings.js bulk-add - Add multiple sample documents');
  }

  process.exit(0);
}

async function bulkAddDocuments() {
  console.log('📝 Adding bulk sample documents...');

  const sampleDocuments = [
    {
      content: "You can cancel your subscription at any time from your account settings. There are no cancellation fees, and you'll continue to have access until the end of your billing period.",
      metadata: { category: "billing", type: "cancellation" }
    },
    {
      content: "We offer a 14-day free trial for all new customers. No credit card required. You can upgrade to a paid plan at any time during or after the trial.",
      metadata: { category: "trial", type: "free_trial" }
    },
    {
      content: "Our mobile app is available for both iOS and Android devices. It includes all the core features of the web platform with offline synchronization.",
      metadata: { category: "features", type: "mobile_app" }
    },
    {
      content: "Data export is available in multiple formats including CSV, Excel, JSON, and PDF. Enterprise customers can also set up automated data exports via API.",
      metadata: { category: "features", type: "data_export" }
    },
    {
      content: "We provide comprehensive onboarding with dedicated setup assistance, training sessions, and migration support for Enterprise customers.",
      metadata: { category: "onboarding", type: "enterprise_onboarding" }
    },
    {
      content: "Our uptime guarantee is 99.9% for all paid plans. We provide status updates at status.ourcompany.com and will credit your account for any downtime.",
      metadata: { category: "reliability", type: "uptime_guarantee" }
    },
    {
      content: "You can integrate with popular CRM systems like Salesforce, HubSpot, and Pipedrive. Custom integrations are available for Enterprise customers.",
      metadata: { category: "integrations", type: "crm" }
    },
    {
      content: "Our team collaboration features include shared dashboards, comment systems, user permissions, and activity logs to track changes.",
      metadata: { category: "features", type: "collaboration" }
    },
    {
      content: "We offer professional services including data migration, custom dashboard setup, training, and ongoing consultation for large implementations.",
      metadata: { category: "services", type: "professional_services" }
    },
    {
      content: "All data is encrypted in transit and at rest using AES-256 encryption. We are SOC 2 Type II certified and GDPR compliant.",
      metadata: { category: "security", type: "compliance" }
    }
  ];

  let added = 0;
  let failed = 0;

  for (const doc of sampleDocuments) {
    try {
      await addCustomDocument(doc.content, doc.metadata);
      added++;

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (error) {
      console.error(`❌ Failed to add document: "${doc.content.substring(0, 30)}..."`, error);
      failed++;
    }
  }

  console.log(`\n🎉 Bulk add complete!`);
  console.log(`✅ Successfully added: ${added} documents`);
  console.log(`❌ Failed: ${failed} documents`);
}

// Enhanced error handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

// Validate environment variables
if (!process.env.GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY environment variable is required');
  process.exit(1);
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_ANON_KEY environment variables are required');
  process.exit(1);
}

// Run the main function
main().catch(error => {
  console.error('❌ Fatal error in main:', error);
  process.exit(1);
});