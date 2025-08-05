require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Sample knowledge base content for a software/SaaS company
const sampleKnowledge = [
  {
    title: "Product Overview",
    content: "Our platform is a comprehensive business management solution that helps companies streamline their operations, manage customer relationships, and boost productivity. It includes CRM, project management, analytics, and automation tools all in one place."
  },
  {
    title: "Pricing Plans",
    content: "We offer three pricing tiers: Starter ($29/month for up to 5 users), Professional ($79/month for up to 25 users), and Enterprise (custom pricing for unlimited users). All plans include 24/7 support and a 30-day free trial."
  },
  {
    title: "Key Features",
    content: "Key features include: Customer relationship management (CRM), project tracking and collaboration, automated workflows, real-time analytics and reporting, mobile apps for iOS and Android, integrations with 100+ popular tools, and advanced security features."
  },
  {
    title: "Free Trial",
    content: "Yes! We offer a 30-day free trial with full access to all features. No credit card required to start. You can upgrade or cancel anytime during the trial period."
  },
  {
    title: "Setup and Onboarding",
    content: "Getting started is easy! After signing up, you'll get access to our guided setup wizard, video tutorials, and a dedicated onboarding specialist. Most customers are up and running within 24 hours."
  },
  {
    title: "Integrations",
    content: "Our platform integrates with over 100 popular business tools including Slack, Microsoft Office 365, Google Workspace, Salesforce, QuickBooks, Mailchimp, Zoom, and many more. We also offer API access for custom integrations."
  },
  {
    title: "Security and Compliance",
    content: "We take security seriously. Our platform is SOC 2 Type II certified, GDPR compliant, and uses enterprise-grade encryption. Data is backed up daily and stored in secure, geographically distributed data centers."
  },
  {
    title: "Customer Support",
    content: "We provide 24/7 customer support via chat, email, and phone. All plans include access to our knowledge base, video tutorials, and community forum. Enterprise customers get dedicated account managers."
  },
  {
    title: "Mobile Apps",
    content: "Yes, we have native mobile apps for both iOS and Android. The mobile apps sync in real-time with the web platform and include most core features like CRM access, task management, and notifications."
  },
  {
    title: "Data Migration",
    content: "We offer free data migration assistance for all new customers. Our team can help you import data from spreadsheets, other CRM systems, or project management tools. The process typically takes 1-3 business days."
  },
  {
    title: "Customization Options",
    content: "The platform is highly customizable. You can create custom fields, workflows, reports, and dashboards. Enterprise customers can also request custom features and white-label options."
  },
  {
    title: "Team Collaboration",
    content: "Built-in collaboration features include shared workspaces, real-time commenting, file sharing, team calendars, and video conferencing integration. Team members can collaborate on projects from anywhere."
  },
  {
    title: "Reporting and Analytics",
    content: "Comprehensive reporting includes sales analytics, project performance metrics, team productivity reports, and custom dashboards. Data can be exported to Excel or accessed via our API for advanced analysis."
  },
  {
    title: "Scalability",
    content: "Our platform scales with your business. Whether you're a small startup or a large enterprise, the system can handle growing data volumes and user counts. Enterprise plans support unlimited users and advanced features."
  },
  {
    title: "Training and Resources",
    content: "We provide extensive training resources including live webinars, on-demand video courses, detailed documentation, and best practice guides. Enterprise customers can request custom training sessions."
  }
];

async function generateEmbedding(text) {
  try {
    const result = await embeddingModel.embedContent(text);
    return result.embedding.values;
  } catch (error) {
    console.error('Error generating embedding:', error);
    throw error;
  }
}

async function populateKnowledgeBase() {
  console.log('Starting to populate knowledge base...');
  
  for (let i = 0; i < sampleKnowledge.length; i++) {
    const item = sampleKnowledge[i];
    console.log(`Processing ${i + 1}/${sampleKnowledge.length}: ${item.title}`);
    
    try {
      // Generate embedding for the content
      const embedding = await generateEmbedding(item.content);
      
      // Insert into Supabase
      const { data, error } = await supabase
        .from('documents')
        .insert({
          title: item.title,
          content: item.content,
          embedding: embedding,
          metadata: {
            source: 'sample_data',
            category: 'product_info',
            created_at: new Date().toISOString()
          }
        });
      
      if (error) {
        console.error(`Error inserting ${item.title}:`, error);
      } else {
        console.log(`✅ Successfully added: ${item.title}`);
      }
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
      
    } catch (error) {
      console.error(`Error processing ${item.title}:`, error);
    }
  }
  
  console.log('✅ Knowledge base population completed!');
}

// Run the script
populateKnowledgeBase().catch(console.error);