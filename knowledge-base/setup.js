// knowledge-base/setup.js
require('dotenv').config();
const KnowledgeBaseDB = require('./database');
const EmbeddingService = require('./embeddings');

class KnowledgeBaseSetup {
  constructor() {
    this.db = new KnowledgeBaseDB();
    this.embeddingService = new EmbeddingService();
  }

  async testConnection() {
    console.log('🔍 Testing database connection...');
    const isConnected = await this.db.testConnection();
    
    if (!isConnected) {
      console.error('❌ Database connection failed. Please check your Supabase configuration.');
      return false;
    }
    
    return true;
  }

  async testEmbeddings() {
    console.log('🔍 Testing embedding generation...');
    
    try {
      const testText = "This is a test sentence for embedding generation.";
      const embedding = await this.embeddingService.generateEmbedding(testText);
      
      if (embedding && embedding.length > 0) {
        console.log(`✅ Embedding generation successful (${embedding.length} dimensions)`);
        return true;
      } else {
        console.error('❌ Embedding generation failed - no embedding returned');
        return false;
      }
    } catch (error) {
      console.error('❌ Embedding generation failed:', error.message);
      return false;
    }
  }

  async addSampleDocuments() {
    console.log('📝 Adding sample knowledge base documents...');
    
    const sampleDocuments = [
      {
        title: "Product Pricing",
        content: "Our Basic plan costs $29/month and includes up to 1,000 users, 10GB storage, and email support. The Professional plan is $79/month with unlimited users, 100GB storage, priority support, and advanced analytics. Enterprise plans start at $199/month with custom features, dedicated support, and unlimited storage.",
        metadata: { category: "pricing", type: "plans" }
      },
      {
        title: "Free Trial Information",
        content: "We offer a 14-day free trial for all new customers. No credit card is required to start your trial. You can upgrade to a paid plan at any time during or after the trial period. All features are available during the trial except for some enterprise-only integrations.",
        metadata: { category: "trial", type: "free_trial" }
      },
      {
        title: "Account Cancellation",
        content: "You can cancel your subscription at any time from your account settings page. There are no cancellation fees or penalties. You'll continue to have access to your account until the end of your current billing period. All your data will be retained for 30 days after cancellation.",
        metadata: { category: "billing", type: "cancellation" }
      },
      {
        title: "Mobile App Features",
        content: "Our mobile app is available for both iOS and Android devices. It includes all core features of the web platform including dashboard viewing, data entry, notifications, and offline synchronization. You can download it from the App Store or Google Play Store.",
        metadata: { category: "features", type: "mobile_app" }
      },
      {
        title: "Data Security",
        content: "All data is encrypted in transit using TLS 1.3 and at rest using AES-256 encryption. We are SOC 2 Type II certified, GDPR compliant, and undergo regular security audits. We never share your data with third parties without your explicit consent.",
        metadata: { category: "security", type: "compliance" }
      },
      {
        title: "Integration Options",
        content: "We integrate with popular CRM systems like Salesforce, HubSpot, and Pipedrive. We also support Zapier for connecting with 3,000+ apps. Enterprise customers can access our REST API for custom integrations. Webhook support is available for real-time data synchronization.",
        metadata: { category: "integrations", type: "crm_api" }
      },
      {
        title: "Customer Support",
        content: "Basic plan customers receive email support with 24-hour response time. Professional plan customers get priority email support with 4-hour response time. Enterprise customers have access to phone support, dedicated account managers, and 1-hour response time SLA.",
        metadata: { category: "support", type: "channels" }
      },
      {
        title: "Data Export",
        content: "You can export your data in multiple formats including CSV, Excel, JSON, and PDF. Exports can be scheduled automatically or triggered manually. Enterprise customers can set up automated data exports via API and receive exports via SFTP or email.",
        metadata: { category: "features", type: "data_export" }
      },
      {
        title: "Team Collaboration",
        content: "Our platform includes team collaboration features such as shared dashboards, comment systems, user permissions and roles, activity logs, and real-time notifications. You can create teams, assign projects, and track progress collaboratively.",
        metadata: { category: "features", type: "collaboration" }
      },
      {
        title: "Uptime and Reliability",
        content: "We guarantee 99.9% uptime for all paid plans with automatic failover and redundancy. Our infrastructure is hosted on AWS with multiple availability zones. Status updates are available at status.ourcompany.com and we provide account credits for any downtime exceeding our SLA.",
        metadata: { category: "reliability", type: "uptime_sla" }
      }
    ];

    let successful = 0;
    let failed = 0;

    for (const doc of sampleDocuments) {
      try {
        console.log(`📄 Processing: ${doc.title}`);
        
        // Generate embedding
        const embedding = await this.embeddingService.generateEmbedding(doc.content);
        
        // Insert document
        await this.db.insertDocument(doc.title, doc.content, doc.metadata, embedding);
        successful++;
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.error(`❌ Failed to add "${doc.title}":`, error.message);
        failed++;
      }
    }

    console.log(`\n📊 Sample documents added:`);
    console.log(`✅ Successful: ${successful}`);
    console.log(`❌ Failed: ${failed}`);
    
    return { successful, failed };
  }

  async testSearch() {
    console.log('🔍 Testing knowledge base search...');
    
    try {
      const testQueries = [
        "How much does the basic plan cost?",
        "Can I cancel my subscription?",
        "Do you have a mobile app?",
        "What integrations do you support?"
      ];

      for (const query of testQueries) {
        console.log(`\n🔎 Query: "${query}"`);
        
        const queryEmbedding = await this.embeddingService.generateEmbedding(query);
        const results = await this.db.searchSimilarDocuments(queryEmbedding, 0.3, 3);
        
        if (results.length > 0) {
          console.log(`✅ Found ${results.length} relevant documents:`);
          results.forEach((result, index) => {
            console.log(`   ${index + 1}. "${result.title}" (similarity: ${(result.similarity * 100).toFixed(1)}%)`);
            console.log(`      Preview: ${result.content.substring(0, 100)}...`);
          });
        } else {
          console.log('⚠️ No relevant documents found');
        }
      }
      
      return true;
    } catch (error) {
      console.error('❌ Search test failed:', error.message);
      return false;
    }
  }

  async getStats() {
    console.log('📊 Getting knowledge base statistics...');
    
    try {
      const stats = await this.db.getDocumentStats();
      
      console.log(`\n📈 Knowledge Base Stats:`);
      console.log(`   Total Documents: ${stats.totalDocuments}`);
      console.log(`   Source Types:`);
      
      Object.entries(stats.sourceTypes).forEach(([type, count]) => {
        console.log(`     - ${type}: ${count} documents`);
      });
      
      return stats;
    } catch (error) {
      console.error('❌ Failed to get stats:', error.message);
      return null;
    }
  }

  async runFullSetup() {
    console.log('🚀 Starting Knowledge Base Setup...\n');
    
    // Test database connection
    const dbConnected = await this.testConnection();
    if (!dbConnected) {
      console.error('❌ Setup failed: Database connection issue');
      return false;
    }

    // Test embedding generation
    const embeddingsWork = await this.testEmbeddings();
    if (!embeddingsWork) {
      console.error('❌ Setup failed: Embedding generation issue');
      return false;
    }

    // Add sample documents
    console.log('\n' + '='.repeat(50));
    const sampleResult = await this.addSampleDocuments();
    
    if (sampleResult.successful === 0) {
      console.error('❌ Setup failed: Could not add any sample documents');
      return false;
    }

    // Test search functionality
    console.log('\n' + '='.repeat(50));
    const searchWorks = await this.testSearch();
    
    if (!searchWorks) {
      console.error('❌ Setup failed: Search functionality issue');
      return false;
    }

    // Show final stats
    console.log('\n' + '='.repeat(50));
    await this.getStats();

    console.log('\n🎉 Knowledge Base Setup Complete!');
    console.log('\n📋 Next Steps:');
    console.log('   1. Add your own documents using:');
    console.log('      npm run ingest-pdf <file-path>');
    console.log('      npm run ingest-gdrive --folder <folder-id>');
    console.log('   2. Test your chatbot at http://localhost:3000');
    console.log('   3. Monitor performance at http://localhost:3000/test-kb');
    
    return true;
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const setup = new KnowledgeBaseSetup();

  try {
    if (args.length === 0 || args[0] === 'full') {
      await setup.runFullSetup();
    } else if (args[0] === 'test') {
      await setup.testConnection();
      await setup.testEmbeddings();
    } else if (args[0] === 'samples') {
      await setup.addSampleDocuments();
    } else if (args[0] === 'search') {
      await setup.testSearch();
    } else if (args[0] === 'stats') {
      await setup.getStats();
    } else {
      console.log('📖 Usage:');
      console.log('  node knowledge-base/setup.js [command]');
      console.log('');
      console.log('Commands:');
      console.log('  full     - Run complete setup (default)');
      console.log('  test     - Test database and embeddings');
      console.log('  samples  - Add sample documents');
      console.log('  search   - Test search functionality');
      console.log('  stats    - Show knowledge base statistics');
    }
  } catch (error) {
    console.error('❌ Setup failed:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = KnowledgeBaseSetup;