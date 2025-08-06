// knowledge-base/database.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

class KnowledgeBaseDB {
  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );
  }

  async insertDocument(title, content, metadata, embedding) {
    try {
      const { data, error } = await this.supabase
        .from('documents')
        .insert([{
          title: title,
          content: content,
          metadata: metadata,
          embedding: embedding,
          source_type: metadata.source_type || 'manual',
          source_url: metadata.source_url || null
        }])
        .select();

      if (error) {
        throw error;
      }

      console.log(`✅ Inserted document: ${title} (ID: ${data[0].id})`);
      return data[0];
    } catch (error) {
      console.error('❌ Error inserting document:', error);
      throw error;
    }
  }

  async insertBulkDocuments(documents) {
    try {
      console.log(`📦 Inserting ${documents.length} documents in bulk...`);
      
      const { data, error } = await this.supabase
        .from('documents')
        .insert(documents)
        .select();

      if (error) {
        throw error;
      }

      console.log(`✅ Successfully inserted ${data.length} documents`);
      return data;
    } catch (error) {
      console.error('❌ Error inserting bulk documents:', error);
      throw error;
    }
  }

  async searchSimilarDocuments(queryEmbedding, threshold = 0.3, limit = 5) {
    try {
      const { data, error } = await this.supabase.rpc('match_documents', {
        query_embedding: queryEmbedding,
        match_threshold: threshold,
        match_count: limit
      });

      if (error) {
        throw error;
      }

      return data || [];
    } catch (error) {
      console.error('❌ Error searching documents:', error);
      throw error;
    }
  }

  async getAllDocuments(limit = 100) {
    try {
      const { data, error } = await this.supabase
        .from('documents')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        throw error;
      }

      return data || [];
    } catch (error) {
      console.error('❌ Error fetching documents:', error);
      throw error;
    }
  }

  async getGroupedDocuments(limit = 100) {
    try {
      const { data, error } = await this.supabase
        .from('documents')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        throw error;
      }

      // Group by filename and show summary
      const grouped = {};
      data.forEach(doc => {
        const filename = doc.metadata?.filename || doc.title;
        if (!grouped[filename]) {
          grouped[filename] = {
            id: doc.id,
            title: filename,
            content: doc.content.substring(0, 200) + '...',
            metadata: {
              ...doc.metadata,
              total_chunks: 0,
              total_characters: 0
            },
            created_at: doc.created_at,
            source_type: doc.source_type,
            chunks: []
          };
        }
        grouped[filename].chunks.push(doc);
        grouped[filename].metadata.total_chunks++;
        grouped[filename].metadata.total_characters += doc.content.length;
      });

      return Object.values(grouped).slice(0, limit);
    } catch (error) {
      console.error('❌ Error fetching grouped documents:', error);
      throw error;
    }
  }

  async deleteDocumentGroup(filename) {
    try {
      const { error } = await this.supabase
        .from('documents')
        .delete()
        .eq('metadata->>filename', filename);

      if (error) {
        throw error;
      }

      console.log(`✅ Deleted all chunks for: ${filename}`);
      return true;
    } catch (error) {
      console.error('❌ Error deleting document group:', error);
      throw error;
    }
  }

  async deleteDocument(id) {
    try {
      const { error } = await this.supabase
        .from('documents')
        .delete()
        .eq('id', id);

      if (error) {
        throw error;
      }

      console.log(`✅ Deleted document ID: ${id}`);
      return true;
    } catch (error) {
      console.error('❌ Error deleting document:', error);
      throw error;
    }
  }

  async updateDocument(id, updates) {
    try {
      const { data, error } = await this.supabase
        .from('documents')
        .update(updates)
        .eq('id', id)
        .select();

      if (error) {
        throw error;
      }

      console.log(`✅ Updated document ID: ${id}`);
      return data[0];
    } catch (error) {
      console.error('❌ Error updating document:', error);
      throw error;
    }
  }

  async getDocumentStats() {
    try {
      const { count, error } = await this.supabase
        .from('documents')
        .select('*', { count: 'exact', head: true });

      if (error) {
        throw error;
      }

      const { data: sourceStats, error: sourceError } = await this.supabase
        .from('documents')
        .select('source_type')
        .not('source_type', 'is', null);

      if (sourceError) {
        throw sourceError;
      }

      const sourceTypeCounts = sourceStats.reduce((acc, doc) => {
        acc[doc.source_type] = (acc[doc.source_type] || 0) + 1;
        return acc;
      }, {});

      return {
        totalDocuments: count,
        sourceTypes: sourceTypeCounts
      };
    } catch (error) {
      console.error('❌ Error getting document stats:', error);
      throw error;
    }
  }

  async logCustomerIntent(sessionId, message, intent, category, confidence, matchedDocs, responseType, customerInfo = null) {
    try {
      const intentData = {
        session_id: sessionId,
        customer_message: message,
        detected_intent: intent,
        intent_category: category,
        confidence_score: confidence,
        matched_documents: matchedDocs,
        response_type: responseType
      };

      if (customerInfo) {
        intentData.customer_firstname = customerInfo.firstname;
        intentData.customer_lastname = customerInfo.lastname;
        intentData.customer_email = customerInfo.email;
        intentData.customer_country = customerInfo.country;
      }

      const { error } = await this.supabase
        .from('customer_intents')
        .insert([intentData]);

      if (error) throw error;
    } catch (error) {
      console.error('❌ Error logging intent:', error);
    }
  }

  async testConnection() {
    try {
      const { data, error } = await this.supabase
        .from('documents')
        .select('count')
        .limit(1);

      if (error) {
        throw error;
      }

      console.log('✅ Database connection successful');
      return true;
    } catch (error) {
      console.error('❌ Database connection failed:', error);
      return false;
    }
  }
}

module.exports = KnowledgeBaseDB;