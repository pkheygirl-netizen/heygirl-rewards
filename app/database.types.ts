export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export interface Database {
  public: {
    Tables: {
      shopify_sessions: {
        Row: {
          id: string;
          shop: string;
          state: string | null;
          is_online: boolean;
          scope: string | null;
          expires: string | null;
          access_token: string | null;
          user_id: number | null;
        };
        Insert: {
          id: string;
          shop: string;
          state?: string | null;
          is_online?: boolean;
          scope?: string | null;
          expires?: string | null;
          access_token?: string | null;
          user_id?: number | null;
        };
        Update: {
          id?: string;
          shop?: string;
          state?: string | null;
          is_online?: boolean;
          scope?: string | null;
          expires?: string | null;
          access_token?: string | null;
          user_id?: number | null;
        };
      };
      members: {
        Row: {
          id: string;
          shopify_customer_id: string;
          email: string;
          first_name: string | null;
          last_name: string | null;
          tier: "silver" | "gold" | "diamond";
          points_balance: number;
          lifetime_spend_pkr: number;
          referral_slug: string;
          referred_by_member_id: string | null;
          birthday_month: number | null;
          birthday_day: number | null;
          consent_given: boolean;
          consent_given_at: string | null;
          is_blocked: boolean;
          is_influencer: boolean;
          influencer_referral_rate: number | null;
          enrolled_at: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          shopify_customer_id: string;
          email: string;
          first_name?: string | null;
          last_name?: string | null;
          tier?: "silver" | "gold" | "diamond";
          points_balance?: number;
          lifetime_spend_pkr?: number;
          referral_slug: string;
          referred_by_member_id?: string | null;
          birthday_month?: number | null;
          birthday_day?: number | null;
          consent_given?: boolean;
          consent_given_at?: string | null;
          is_blocked?: boolean;
          is_influencer?: boolean;
          influencer_referral_rate?: number | null;
          enrolled_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          shopify_customer_id?: string;
          email?: string;
          first_name?: string | null;
          last_name?: string | null;
          tier?: "silver" | "gold" | "diamond";
          points_balance?: number;
          lifetime_spend_pkr?: number;
          referral_slug?: string;
          referred_by_member_id?: string | null;
          birthday_month?: number | null;
          birthday_day?: number | null;
          consent_given?: boolean;
          consent_given_at?: string | null;
          is_blocked?: boolean;
          is_influencer?: boolean;
          influencer_referral_rate?: number | null;
          enrolled_at?: string;
          updated_at?: string;
        };
      };
      points_ledger: {
        Row: {
          id: string;
          member_id: string;
          points: number;
          action_type:
            | "signup"
            | "purchase"
            | "social_youtube"
            | "social_facebook"
            | "social_instagram"
            | "review"
            | "referral_earned"
            | "referral_bonus"
            | "redemption"
            | "expiry"
            | "adjustment"
            | "birthday"
            | "campaign_bonus"
            | "refund_deduction";
          shopify_order_id: string | null;
          reference_id: string | null;
          reason_note: string | null;
          balance_after: number;
          earned_at: string;
          expires_at: string | null;
          expired: boolean;
        };
        Insert: {
          id?: string;
          member_id: string;
          points: number;
          action_type:
            | "signup"
            | "purchase"
            | "social_youtube"
            | "social_facebook"
            | "social_instagram"
            | "review"
            | "referral_earned"
            | "referral_bonus"
            | "redemption"
            | "expiry"
            | "adjustment"
            | "birthday"
            | "campaign_bonus"
            | "refund_deduction";
          shopify_order_id?: string | null;
          reference_id?: string | null;
          reason_note?: string | null;
          balance_after: number;
          earned_at?: string;
          expires_at?: string | null;
          expired?: boolean;
        };
        Update: {
          member_id?: string;
          points?: number;
          action_type?: string;
          shopify_order_id?: string | null;
          reference_id?: string | null;
          reason_note?: string | null;
          balance_after?: number;
          earned_at?: string;
          expires_at?: string | null;
          expired?: boolean;
        };
      };
      order_webhook_state: {
        Row: {
          id: string;
          shopify_order_id: string;
          shopify_customer_id: string | null;
          fulfillment_status: string | null;
          financial_status: string | null;
          points_awarded: boolean;
          order_total_pkr: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          shopify_order_id: string;
          shopify_customer_id?: string | null;
          fulfillment_status?: string | null;
          financial_status?: string | null;
          points_awarded?: boolean;
          order_total_pkr?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          shopify_order_id?: string;
          shopify_customer_id?: string | null;
          fulfillment_status?: string | null;
          financial_status?: string | null;
          points_awarded?: boolean;
          order_total_pkr?: number | null;
          updated_at?: string;
        };
      };
      loyalty_codes: {
        Row: {
          id: string;
          member_id: string;
          shopify_discount_code_id: string | null;
          code: string;
          discount_amount: number;
          points_spent: number;
          status: "active" | "used" | "expired";
          expires_at: string;
          used_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          member_id: string;
          shopify_discount_code_id?: string | null;
          code: string;
          discount_amount: number;
          points_spent: number;
          status?: "active" | "used" | "expired";
          expires_at: string;
          used_at?: string | null;
          created_at?: string;
        };
        Update: {
          shopify_discount_code_id?: string | null;
          code?: string;
          discount_amount?: number;
          points_spent?: number;
          status?: "active" | "used" | "expired";
          expires_at?: string;
          used_at?: string | null;
        };
      };
      referrals: {
        Row: {
          id: string;
          referrer_member_id: string;
          referred_shopify_customer_id: string | null;
          referred_email: string;
          referred_ip: string | null;
          referrer_ip: string | null;
          status: "pending" | "completed" | "blocked" | "flagged";
          block_reason: string | null;
          shopify_order_id: string | null;
          points_awarded: boolean;
          created_at: string;
          completed_at: string | null;
        };
        Insert: {
          id?: string;
          referrer_member_id: string;
          referred_shopify_customer_id?: string | null;
          referred_email: string;
          referred_ip?: string | null;
          referrer_ip?: string | null;
          status?: "pending" | "completed" | "blocked" | "flagged";
          block_reason?: string | null;
          shopify_order_id?: string | null;
          points_awarded?: boolean;
          created_at?: string;
          completed_at?: string | null;
        };
        Update: {
          referred_shopify_customer_id?: string | null;
          status?: "pending" | "completed" | "blocked" | "flagged";
          block_reason?: string | null;
          shopify_order_id?: string | null;
          points_awarded?: boolean;
          completed_at?: string | null;
        };
      };
      social_actions: {
        Row: {
          id: string;
          member_id: string;
          action_type: "youtube" | "facebook" | "instagram";
          status: "pending" | "awarded" | "voided";
          pending_until: string;
          points_awarded: number | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          member_id: string;
          action_type: "youtube" | "facebook" | "instagram";
          status?: "pending" | "awarded" | "voided";
          pending_until: string;
          points_awarded?: number | null;
          created_at?: string;
        };
        Update: {
          status?: "pending" | "awarded" | "voided";
          points_awarded?: number | null;
        };
      };
      bonus_campaigns: {
        Row: {
          id: string;
          name: string;
          multiplier: number;
          starts_at: string;
          ends_at: string;
          is_active: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          multiplier?: number;
          starts_at: string;
          ends_at: string;
          is_active?: boolean;
          created_at?: string;
        };
        Update: {
          name?: string;
          multiplier?: number;
          starts_at?: string;
          ends_at?: string;
          is_active?: boolean;
        };
      };
      app_settings: {
        Row: {
          id: number;
          program_name: string;
          brand_color_primary: string;
          brand_color_secondary: string;
          tagline: string;
          tier_gold_threshold_pkr: number;
          tier_diamond_threshold_pkr: number;
          signup_points: number;
          purchase_points_rate: number;
          referral_points: number;
          social_points: number;
          review_points: number;
          silver_expiry_days: number;
          whatsapp_enabled: boolean;
          whatsapp_provider: string | null;
          whatsapp_api_key: string | null;
          wa_referral_template: string | null;
          nudge_account_creation_enabled: boolean;
          nudge_points_spending_enabled: boolean;
          nudge_reward_usage_enabled: boolean;
          nudge_post_purchase_enabled: boolean;
          nudge_tier_progress_enabled: boolean;
          tier_progress_gold_threshold_pkr: number;
          tier_progress_diamond_threshold_pkr: number;
          updated_at: string;
        };
        Insert: {
          id?: number;
          program_name?: string;
          brand_color_primary?: string;
          brand_color_secondary?: string;
          tagline?: string;
          tier_gold_threshold_pkr?: number;
          tier_diamond_threshold_pkr?: number;
          signup_points?: number;
          purchase_points_rate?: number;
          referral_points?: number;
          social_points?: number;
          review_points?: number;
          silver_expiry_days?: number;
          whatsapp_enabled?: boolean;
          whatsapp_provider?: string | null;
          whatsapp_api_key?: string | null;
          wa_referral_template?: string | null;
          nudge_account_creation_enabled?: boolean;
          nudge_points_spending_enabled?: boolean;
          nudge_reward_usage_enabled?: boolean;
          nudge_post_purchase_enabled?: boolean;
          nudge_tier_progress_enabled?: boolean;
          tier_progress_gold_threshold_pkr?: number;
          tier_progress_diamond_threshold_pkr?: number;
          updated_at?: string;
        };
        Update: {
          program_name?: string;
          brand_color_primary?: string;
          brand_color_secondary?: string;
          tagline?: string;
          tier_gold_threshold_pkr?: number;
          tier_diamond_threshold_pkr?: number;
          signup_points?: number;
          purchase_points_rate?: number;
          referral_points?: number;
          social_points?: number;
          review_points?: number;
          silver_expiry_days?: number;
          whatsapp_enabled?: boolean;
          whatsapp_provider?: string | null;
          whatsapp_api_key?: string | null;
          wa_referral_template?: string | null;
          nudge_account_creation_enabled?: boolean;
          nudge_points_spending_enabled?: boolean;
          nudge_reward_usage_enabled?: boolean;
          nudge_post_purchase_enabled?: boolean;
          nudge_tier_progress_enabled?: boolean;
          tier_progress_gold_threshold_pkr?: number;
          tier_progress_diamond_threshold_pkr?: number;
          updated_at?: string;
        };
      };
    };
  };
}
