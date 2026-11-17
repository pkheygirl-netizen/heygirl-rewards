export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      app_settings: {
        Row: {
          birthday_reward_diamond_pkr: number
          birthday_reward_gold_pkr: number
          birthday_reward_silver_pkr: number
          bonus_campaign_default_multiplier: number
          brand_color_primary: string
          brand_color_secondary: string
          earn_rules: Json
          faqs: Json
          id: number
          influencer_cta_link: string | null
          nudge_account_creation_enabled: boolean
          nudge_points_spending_enabled: boolean
          nudge_post_purchase_enabled: boolean
          nudge_reward_usage_enabled: boolean
          nudge_tier_progress_enabled: boolean
          nudges_config: Json
          program_enabled: boolean
          program_name: string
          purchase_points_rate: number
          redemption_tiers: Json
          referral_friend_discount_pkr: number
          referral_friend_free_shipping: boolean
          referral_points: number
          review_points: number
          review_release_hours: number
          reward_code_expiry_days: number
          shopify_email_injection_enabled: boolean
          signup_points: number
          silver_expiry_days: number
          social_points: number
          social_points_facebook: number
          social_points_instagram: number
          social_points_youtube: number
          social_url_facebook: string | null
          social_url_instagram: string | null
          social_url_youtube: string | null
          tagline: string
          terms_and_conditions: string | null
          tier_diamond_threshold_pkr: number
          tier_gold_threshold_pkr: number
          tier_progress_diamond_threshold_pkr: number
          tier_progress_gold_threshold_pkr: number
          tier_reward_diamond_pkr: number
          tier_reward_gold_free_shipping: boolean
          updated_at: string
          wa_referral_template: string | null
          whatsapp_api_key: string | null
          whatsapp_enabled: boolean
          whatsapp_provider: string | null
        }
        Insert: {
          birthday_reward_diamond_pkr?: number
          birthday_reward_gold_pkr?: number
          birthday_reward_silver_pkr?: number
          bonus_campaign_default_multiplier?: number
          brand_color_primary?: string
          brand_color_secondary?: string
          earn_rules?: Json
          faqs?: Json
          id?: number
          influencer_cta_link?: string | null
          nudge_account_creation_enabled?: boolean
          nudge_points_spending_enabled?: boolean
          nudge_post_purchase_enabled?: boolean
          nudge_reward_usage_enabled?: boolean
          nudge_tier_progress_enabled?: boolean
          nudges_config?: Json
          program_enabled?: boolean
          program_name?: string
          purchase_points_rate?: number
          redemption_tiers?: Json
          referral_friend_discount_pkr?: number
          referral_friend_free_shipping?: boolean
          referral_points?: number
          review_points?: number
          review_release_hours?: number
          reward_code_expiry_days?: number
          shopify_email_injection_enabled?: boolean
          signup_points?: number
          silver_expiry_days?: number
          social_points?: number
          social_points_facebook?: number
          social_points_instagram?: number
          social_points_youtube?: number
          social_url_facebook?: string | null
          social_url_instagram?: string | null
          social_url_youtube?: string | null
          tagline?: string
          terms_and_conditions?: string | null
          tier_diamond_threshold_pkr?: number
          tier_gold_threshold_pkr?: number
          tier_progress_diamond_threshold_pkr?: number
          tier_progress_gold_threshold_pkr?: number
          tier_reward_diamond_pkr?: number
          tier_reward_gold_free_shipping?: boolean
          updated_at?: string
          wa_referral_template?: string | null
          whatsapp_api_key?: string | null
          whatsapp_enabled?: boolean
          whatsapp_provider?: string | null
        }
        Update: {
          birthday_reward_diamond_pkr?: number
          birthday_reward_gold_pkr?: number
          birthday_reward_silver_pkr?: number
          bonus_campaign_default_multiplier?: number
          brand_color_primary?: string
          brand_color_secondary?: string
          earn_rules?: Json
          faqs?: Json
          id?: number
          influencer_cta_link?: string | null
          nudge_account_creation_enabled?: boolean
          nudge_points_spending_enabled?: boolean
          nudge_post_purchase_enabled?: boolean
          nudge_reward_usage_enabled?: boolean
          nudge_tier_progress_enabled?: boolean
          nudges_config?: Json
          program_enabled?: boolean
          program_name?: string
          purchase_points_rate?: number
          redemption_tiers?: Json
          referral_friend_discount_pkr?: number
          referral_friend_free_shipping?: boolean
          referral_points?: number
          review_points?: number
          review_release_hours?: number
          reward_code_expiry_days?: number
          shopify_email_injection_enabled?: boolean
          signup_points?: number
          silver_expiry_days?: number
          social_points?: number
          social_points_facebook?: number
          social_points_instagram?: number
          social_points_youtube?: number
          social_url_facebook?: string | null
          social_url_instagram?: string | null
          social_url_youtube?: string | null
          tagline?: string
          terms_and_conditions?: string | null
          tier_diamond_threshold_pkr?: number
          tier_gold_threshold_pkr?: number
          tier_progress_diamond_threshold_pkr?: number
          tier_progress_gold_threshold_pkr?: number
          tier_reward_diamond_pkr?: number
          tier_reward_gold_free_shipping?: boolean
          updated_at?: string
          wa_referral_template?: string | null
          whatsapp_api_key?: string | null
          whatsapp_enabled?: boolean
          whatsapp_provider?: string | null
        }
        Relationships: []
      }
      bonus_campaigns: {
        Row: {
          created_at: string
          deactivated_at: string | null
          ends_at: string
          id: string
          is_active: boolean
          multiplier: number
          name: string
          starts_at: string
        }
        Insert: {
          created_at?: string
          deactivated_at?: string | null
          ends_at: string
          id?: string
          is_active?: boolean
          multiplier?: number
          name: string
          starts_at: string
        }
        Update: {
          created_at?: string
          deactivated_at?: string | null
          ends_at?: string
          id?: string
          is_active?: boolean
          multiplier?: number
          name?: string
          starts_at?: string
        }
        Relationships: []
      }
      gdpr_requests: {
        Row: {
          created_at: string
          id: string
          payload: Json | null
          shopify_customer_id: string | null
          status: string
          type: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          payload?: Json | null
          shopify_customer_id?: string | null
          status?: string
          type: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          payload?: Json | null
          shopify_customer_id?: string | null
          status?: string
          type?: string
          updated_at?: string
        }
        Relationships: []
      }
      import_rows: {
        Row: {
          email: string | null
          file_points: number
          member_existed: boolean | null
          member_id: string | null
          points: number
          points_awarded: number | null
          reason: string | null
          row_number: number
          run_id: string
          shopify_customer_id: string | null
          shopify_first_name: string | null
          shopify_last_name: string | null
          shopify_phone: string | null
          smile_customer_id: string
          smile_status: string | null
          state: string
          vip_tier_name: string | null
        }
        Insert: {
          email?: string | null
          file_points?: number
          member_existed?: boolean | null
          member_id?: string | null
          points?: number
          points_awarded?: number | null
          reason?: string | null
          row_number: number
          run_id: string
          shopify_customer_id?: string | null
          shopify_first_name?: string | null
          shopify_last_name?: string | null
          shopify_phone?: string | null
          smile_customer_id?: string
          smile_status?: string | null
          state: string
          vip_tier_name?: string | null
        }
        Update: {
          email?: string | null
          file_points?: number
          member_existed?: boolean | null
          member_id?: string | null
          points?: number
          points_awarded?: number | null
          reason?: string | null
          row_number?: number
          run_id?: string
          shopify_customer_id?: string | null
          shopify_first_name?: string | null
          shopify_last_name?: string | null
          shopify_phone?: string | null
          smile_customer_id?: string
          smile_status?: string | null
          state?: string
          vip_tier_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "import_rows_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "import_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      import_runs: {
        Row: {
          created_at: string
          created_by: string | null
          error: string | null
          file_name: string | null
          finished_at: string | null
          id: string
          options: Json
          phase: string
          progress: Json
          source: string
          started_at: string | null
          status: string
          totals: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          error?: string | null
          file_name?: string | null
          finished_at?: string | null
          id?: string
          options?: Json
          phase?: string
          progress?: Json
          source?: string
          started_at?: string | null
          status?: string
          totals?: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          error?: string | null
          file_name?: string | null
          finished_at?: string | null
          id?: string
          options?: Json
          phase?: string
          progress?: Json
          source?: string
          started_at?: string | null
          status?: string
          totals?: Json
          updated_at?: string
        }
        Relationships: []
      }
      loyalty_codes: {
        Row: {
          cancelled_at: string | null
          code: string
          created_at: string
          discount_amount: number
          discount_amount_pkr: number
          expires_at: string
          id: string
          issue_key: string | null
          kind: string
          member_id: string
          points_spent: number
          shopify_discount_code_id: string | null
          shopify_discount_id: string | null
          shopify_order_id: string | null
          shopify_price_rule_id: string | null
          status: string
          used_at: string | null
        }
        Insert: {
          cancelled_at?: string | null
          code: string
          created_at?: string
          discount_amount: number
          discount_amount_pkr?: number
          expires_at: string
          id?: string
          issue_key?: string | null
          kind?: string
          member_id: string
          points_spent: number
          shopify_discount_code_id?: string | null
          shopify_discount_id?: string | null
          shopify_order_id?: string | null
          shopify_price_rule_id?: string | null
          status?: string
          used_at?: string | null
        }
        Update: {
          cancelled_at?: string | null
          code?: string
          created_at?: string
          discount_amount?: number
          discount_amount_pkr?: number
          expires_at?: string
          id?: string
          issue_key?: string | null
          kind?: string
          member_id?: string
          points_spent?: number
          shopify_discount_code_id?: string | null
          shopify_discount_id?: string | null
          shopify_order_id?: string | null
          shopify_price_rule_id?: string | null
          status?: string
          used_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "loyalty_codes_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      members: {
        Row: {
          birthday_day: number | null
          birthday_month: number | null
          birthday_set_at: string | null
          consent_given: boolean
          consent_given_at: string | null
          consent_source: string | null
          created_at: string
          email: string | null
          enrolled_at: string
          first_name: string | null
          first_order_awarded_at: string | null
          id: string
          imported_from_smile: boolean
          influencer_campaign: string | null
          influencer_code: string | null
          influencer_code_discount_id: string | null
          influencer_code_percent: number | null
          influencer_multiplier: number | null
          influencer_paused: boolean
          influencer_rate_ends_at: string | null
          influencer_rate_starts_at: string | null
          influencer_referral_rate: number | null
          is_blocked: boolean
          is_influencer: boolean
          last_name: string | null
          last_seen_ip: string | null
          lifetime_spend_pkr: number
          opted_out: boolean
          phone: string | null
          points_balance: number
          referral_slug: string
          referrals_blocked: boolean
          referred_by_member_id: string | null
          shopify_customer_id: string
          tier: string
          updated_at: string
        }
        Insert: {
          birthday_day?: number | null
          birthday_month?: number | null
          birthday_set_at?: string | null
          consent_given?: boolean
          consent_given_at?: string | null
          consent_source?: string | null
          created_at?: string
          email?: string | null
          enrolled_at?: string
          first_name?: string | null
          first_order_awarded_at?: string | null
          id?: string
          imported_from_smile?: boolean
          influencer_campaign?: string | null
          influencer_code?: string | null
          influencer_code_discount_id?: string | null
          influencer_code_percent?: number | null
          influencer_multiplier?: number | null
          influencer_paused?: boolean
          influencer_rate_ends_at?: string | null
          influencer_rate_starts_at?: string | null
          influencer_referral_rate?: number | null
          is_blocked?: boolean
          is_influencer?: boolean
          last_name?: string | null
          last_seen_ip?: string | null
          lifetime_spend_pkr?: number
          opted_out?: boolean
          phone?: string | null
          points_balance?: number
          referral_slug: string
          referrals_blocked?: boolean
          referred_by_member_id?: string | null
          shopify_customer_id: string
          tier?: string
          updated_at?: string
        }
        Update: {
          birthday_day?: number | null
          birthday_month?: number | null
          birthday_set_at?: string | null
          consent_given?: boolean
          consent_given_at?: string | null
          consent_source?: string | null
          created_at?: string
          email?: string | null
          enrolled_at?: string
          first_name?: string | null
          first_order_awarded_at?: string | null
          id?: string
          imported_from_smile?: boolean
          influencer_campaign?: string | null
          influencer_code?: string | null
          influencer_code_discount_id?: string | null
          influencer_code_percent?: number | null
          influencer_multiplier?: number | null
          influencer_paused?: boolean
          influencer_rate_ends_at?: string | null
          influencer_rate_starts_at?: string | null
          influencer_referral_rate?: number | null
          is_blocked?: boolean
          is_influencer?: boolean
          last_name?: string | null
          last_seen_ip?: string | null
          lifetime_spend_pkr?: number
          opted_out?: boolean
          phone?: string | null
          points_balance?: number
          referral_slug?: string
          referrals_blocked?: boolean
          referred_by_member_id?: string | null
          shopify_customer_id?: string
          tier?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "members_referred_by_member_id_fkey"
            columns: ["referred_by_member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_log: {
        Row: {
          event_type: string
          id: string
          member_id: string
          reference_id: string
          sent_at: string
        }
        Insert: {
          event_type: string
          id?: string
          member_id: string
          reference_id?: string
          sent_at?: string
        }
        Update: {
          event_type?: string
          id?: string
          member_id?: string
          reference_id?: string
          sent_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_log_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      order_webhook_state: {
        Row: {
          campaign_id: string | null
          cancelled_at: string | null
          created_at: string
          discount_codes: string[]
          earning_basis_pkr: number | null
          financial_status: string | null
          fulfillment_status: string | null
          gift_card_amount_pkr: number
          gross_basis_pkr: number | null
          id: string
          influencer_member_id: string | null
          is_first_order: boolean | null
          multiplier_used: number | null
          order_name: string | null
          order_total_pkr: number | null
          pending_points: number
          placed_at: string | null
          points_awarded: boolean
          points_awarded_amount: number
          points_rate: number | null
          points_reversed_amount: number
          refund_basis_at_award_pkr: number
          refund_events_basis_pkr: number
          refund_ids: string[]
          refunded_basis_pkr: number
          shopify_customer_id: string | null
          shopify_order_id: string
          source_updated_at: string | null
          spend_reversed_pkr: number
          taxes_included: boolean
          updated_at: string
        }
        Insert: {
          campaign_id?: string | null
          cancelled_at?: string | null
          created_at?: string
          discount_codes?: string[]
          earning_basis_pkr?: number | null
          financial_status?: string | null
          fulfillment_status?: string | null
          gift_card_amount_pkr?: number
          gross_basis_pkr?: number | null
          id?: string
          influencer_member_id?: string | null
          is_first_order?: boolean | null
          multiplier_used?: number | null
          order_name?: string | null
          order_total_pkr?: number | null
          pending_points?: number
          placed_at?: string | null
          points_awarded?: boolean
          points_awarded_amount?: number
          points_rate?: number | null
          points_reversed_amount?: number
          refund_basis_at_award_pkr?: number
          refund_events_basis_pkr?: number
          refund_ids?: string[]
          refunded_basis_pkr?: number
          shopify_customer_id?: string | null
          shopify_order_id: string
          source_updated_at?: string | null
          spend_reversed_pkr?: number
          taxes_included?: boolean
          updated_at?: string
        }
        Update: {
          campaign_id?: string | null
          cancelled_at?: string | null
          created_at?: string
          discount_codes?: string[]
          earning_basis_pkr?: number | null
          financial_status?: string | null
          fulfillment_status?: string | null
          gift_card_amount_pkr?: number
          gross_basis_pkr?: number | null
          id?: string
          influencer_member_id?: string | null
          is_first_order?: boolean | null
          multiplier_used?: number | null
          order_name?: string | null
          order_total_pkr?: number | null
          pending_points?: number
          placed_at?: string | null
          points_awarded?: boolean
          points_awarded_amount?: number
          points_rate?: number | null
          points_reversed_amount?: number
          refund_basis_at_award_pkr?: number
          refund_events_basis_pkr?: number
          refund_ids?: string[]
          refunded_basis_pkr?: number
          shopify_customer_id?: string | null
          shopify_order_id?: string
          source_updated_at?: string | null
          spend_reversed_pkr?: number
          taxes_included?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_webhook_state_influencer_member_id_fkey"
            columns: ["influencer_member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      points_ledger: {
        Row: {
          action_type: string
          balance_after: number
          customer_note: string | null
          earned_at: string
          expired: boolean
          expires_at: string | null
          id: string
          member_id: string
          points: number
          points_remaining: number | null
          reason_note: string | null
          reference_id: string | null
          shopify_order_id: string | null
        }
        Insert: {
          action_type: string
          balance_after: number
          customer_note?: string | null
          earned_at?: string
          expired?: boolean
          expires_at?: string | null
          id?: string
          member_id: string
          points: number
          points_remaining?: number | null
          reason_note?: string | null
          reference_id?: string | null
          shopify_order_id?: string | null
        }
        Update: {
          action_type?: string
          balance_after?: number
          customer_note?: string | null
          earned_at?: string
          expired?: boolean
          expires_at?: string | null
          id?: string
          member_id?: string
          points?: number
          points_remaining?: number | null
          reason_note?: string | null
          reference_id?: string | null
          shopify_order_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "points_ledger_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      referrals: {
        Row: {
          block_reason: string | null
          completed_at: string | null
          created_at: string
          device_fingerprint_hash: string | null
          fraud_flags: string[]
          friend_code_id: string | null
          id: string
          points_awarded: boolean
          referred_email: string | null
          referred_ip: string | null
          referred_shipping_address_hash: string | null
          referred_shopify_customer_id: string | null
          referrer_ip: string | null
          referrer_member_id: string
          reviewed_at: string | null
          reviewed_note: string | null
          reward_points: number | null
          shopify_order_id: string | null
          status: string
        }
        Insert: {
          block_reason?: string | null
          completed_at?: string | null
          created_at?: string
          device_fingerprint_hash?: string | null
          fraud_flags?: string[]
          friend_code_id?: string | null
          id?: string
          points_awarded?: boolean
          referred_email?: string | null
          referred_ip?: string | null
          referred_shipping_address_hash?: string | null
          referred_shopify_customer_id?: string | null
          referrer_ip?: string | null
          referrer_member_id: string
          reviewed_at?: string | null
          reviewed_note?: string | null
          reward_points?: number | null
          shopify_order_id?: string | null
          status?: string
        }
        Update: {
          block_reason?: string | null
          completed_at?: string | null
          created_at?: string
          device_fingerprint_hash?: string | null
          fraud_flags?: string[]
          friend_code_id?: string | null
          id?: string
          points_awarded?: boolean
          referred_email?: string | null
          referred_ip?: string | null
          referred_shipping_address_hash?: string | null
          referred_shopify_customer_id?: string | null
          referrer_ip?: string | null
          referrer_member_id?: string
          reviewed_at?: string | null
          reviewed_note?: string | null
          reward_points?: number | null
          shopify_order_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "referrals_referrer_member_id_fkey"
            columns: ["referrer_member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      review_claims: {
        Row: {
          claimed_at: string
          id: string
          member_id: string
          points: number
          release_at: string
          resolved_at: string | null
          shopify_order_id: string | null
          status: string
        }
        Insert: {
          claimed_at?: string
          id?: string
          member_id: string
          points: number
          release_at: string
          resolved_at?: string | null
          shopify_order_id?: string | null
          status?: string
        }
        Update: {
          claimed_at?: string
          id?: string
          member_id?: string
          points?: number
          release_at?: string
          resolved_at?: string | null
          shopify_order_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "review_claims_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      shopify_sessions: {
        Row: {
          access_token: string | null
          expires: string | null
          id: string
          is_online: boolean
          scope: string | null
          shop: string
          state: string | null
          user_id: number | null
        }
        Insert: {
          access_token?: string | null
          expires?: string | null
          id: string
          is_online?: boolean
          scope?: string | null
          shop: string
          state?: string | null
          user_id?: number | null
        }
        Update: {
          access_token?: string | null
          expires?: string | null
          id?: string
          is_online?: boolean
          scope?: string | null
          shop?: string
          state?: string | null
          user_id?: number | null
        }
        Relationships: []
      }
      staff_notes: {
        Row: {
          author: string | null
          created_at: string
          id: string
          member_id: string
          note: string
        }
        Insert: {
          author?: string | null
          created_at?: string
          id?: string
          member_id: string
          note: string
        }
        Update: {
          author?: string | null
          created_at?: string
          id?: string
          member_id?: string
          note?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_notes_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      social_actions: {
        Row: {
          action_type: string
          created_at: string
          id: string
          member_id: string
          pending_until: string
          points_awarded: number | null
          status: string
        }
        Insert: {
          action_type: string
          created_at?: string
          id?: string
          member_id: string
          pending_until: string
          points_awarded?: number | null
          status?: string
        }
        Update: {
          action_type?: string
          created_at?: string
          id?: string
          member_id?: string
          pending_until?: string
          points_awarded?: number | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_actions_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      system_heartbeat: {
        Row: {
          at: string
          detail: Json
          key: string
        }
        Insert: {
          at: string
          detail?: Json
          key: string
        }
        Update: {
          at?: string
          detail?: Json
          key?: string
        }
        Relationships: []
      }
      tier_history: {
        Row: {
          created_at: string
          from_tier: string | null
          id: string
          member_id: string
          shopify_order_id: string | null
          to_tier: string | null
        }
        Insert: {
          created_at?: string
          from_tier?: string | null
          id?: string
          member_id: string
          shopify_order_id?: string | null
          to_tier?: string | null
        }
        Update: {
          created_at?: string
          from_tier?: string | null
          id?: string
          member_id?: string
          shopify_order_id?: string | null
          to_tier?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tier_history_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      award_order_points: {
        Args: {
          p_basis_pkr: number
          p_expires_at: string | null
          p_member_id: string
          p_multiplier: number
          p_points: number
          p_shopify_order_id: string
        }
        Returns: {
          awarded: boolean
          new_balance: number
          new_lifetime_spend_pkr: number
        }[]
      }
      award_points: {
        Args: {
          p_action_type: string
          p_customer_note?: string | null
          p_expires_at?: string | null
          p_member_id: string
          p_points: number
          p_purchase_amount_pkr?: number | null
          p_reason_note?: string | null
          p_reference_id: string | null
          p_shopify_order_id?: string | null
        }
        Returns: {
          awarded: boolean
          new_balance: number
          new_lifetime_spend_pkr: number
        }[]
      }
      reconcile_order_points: {
        Args: {
          p_note?: string
          p_reference_id: string
          p_shopify_order_id: string
        }
        Returns: {
          reversed: number
          new_balance: number | null
        }[]
      }
      reverse_order_points: {
        Args: {
          p_kind: string
          p_reference_id: string
          p_refunded_basis_pkr?: number | null
          p_shopify_order_id: string
        }
        Returns: {
          reversed: number
          new_balance: number | null
        }[]
      }
      sync_order_snapshot: {
        Args: {
          p_can_earn: boolean
          p_current_basis_pkr: number
          p_gross_basis_pkr: number
          p_points_rate: number
          p_shopify_order_id: string
          p_source_updated_at: string | null
        }
        Returns: {
          applied: boolean
          reversed: number
          pending_points: number
        }[]
      }
      upgrade_member_tier: {
        Args: {
          p_member_id: string
          p_shopify_order_id?: string | null
          p_to_tier: string
        }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
