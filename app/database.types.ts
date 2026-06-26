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
          brand_color_primary: string
          brand_color_secondary: string
          id: number
          nudge_account_creation_enabled: boolean
          nudge_points_spending_enabled: boolean
          nudge_post_purchase_enabled: boolean
          nudge_reward_usage_enabled: boolean
          nudge_tier_progress_enabled: boolean
          program_name: string
          purchase_points_rate: number
          referral_points: number
          review_points: number
          signup_points: number
          silver_expiry_days: number
          social_points: number
          tagline: string
          tier_diamond_threshold_pkr: number
          tier_gold_threshold_pkr: number
          tier_progress_diamond_threshold_pkr: number
          tier_progress_gold_threshold_pkr: number
          updated_at: string
          wa_referral_template: string | null
          whatsapp_api_key: string | null
          whatsapp_enabled: boolean
          whatsapp_provider: string | null
        }
        Insert: {
          brand_color_primary?: string
          brand_color_secondary?: string
          id?: number
          nudge_account_creation_enabled?: boolean
          nudge_points_spending_enabled?: boolean
          nudge_post_purchase_enabled?: boolean
          nudge_reward_usage_enabled?: boolean
          nudge_tier_progress_enabled?: boolean
          program_name?: string
          purchase_points_rate?: number
          referral_points?: number
          review_points?: number
          signup_points?: number
          silver_expiry_days?: number
          social_points?: number
          tagline?: string
          tier_diamond_threshold_pkr?: number
          tier_gold_threshold_pkr?: number
          tier_progress_diamond_threshold_pkr?: number
          tier_progress_gold_threshold_pkr?: number
          updated_at?: string
          wa_referral_template?: string | null
          whatsapp_api_key?: string | null
          whatsapp_enabled?: boolean
          whatsapp_provider?: string | null
        }
        Update: {
          brand_color_primary?: string
          brand_color_secondary?: string
          id?: number
          nudge_account_creation_enabled?: boolean
          nudge_points_spending_enabled?: boolean
          nudge_post_purchase_enabled?: boolean
          nudge_reward_usage_enabled?: boolean
          nudge_tier_progress_enabled?: boolean
          program_name?: string
          purchase_points_rate?: number
          referral_points?: number
          review_points?: number
          signup_points?: number
          silver_expiry_days?: number
          social_points?: number
          tagline?: string
          tier_diamond_threshold_pkr?: number
          tier_gold_threshold_pkr?: number
          tier_progress_diamond_threshold_pkr?: number
          tier_progress_gold_threshold_pkr?: number
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
          ends_at: string
          id: string
          is_active: boolean
          multiplier: number
          name: string
          starts_at: string
        }
        Insert: {
          created_at?: string
          ends_at: string
          id?: string
          is_active?: boolean
          multiplier?: number
          name: string
          starts_at: string
        }
        Update: {
          created_at?: string
          ends_at?: string
          id?: string
          is_active?: boolean
          multiplier?: number
          name?: string
          starts_at?: string
        }
        Relationships: []
      }
      loyalty_codes: {
        Row: {
          code: string
          created_at: string
          discount_amount: number
          expires_at: string
          id: string
          member_id: string
          points_spent: number
          shopify_discount_code_id: string | null
          status: string
          used_at: string | null
        }
        Insert: {
          code: string
          created_at?: string
          discount_amount: number
          expires_at: string
          id?: string
          member_id: string
          points_spent: number
          shopify_discount_code_id?: string | null
          status?: string
          used_at?: string | null
        }
        Update: {
          code?: string
          created_at?: string
          discount_amount?: number
          expires_at?: string
          id?: string
          member_id?: string
          points_spent?: number
          shopify_discount_code_id?: string | null
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
          consent_given: boolean
          consent_given_at: string | null
          created_at: string
          email: string
          enrolled_at: string
          first_name: string | null
          id: string
          influencer_referral_rate: number | null
          is_blocked: boolean
          is_influencer: boolean
          last_name: string | null
          lifetime_spend_pkr: number
          points_balance: number
          referral_slug: string
          referred_by_member_id: string | null
          shopify_customer_id: string
          tier: string
          updated_at: string
        }
        Insert: {
          birthday_day?: number | null
          birthday_month?: number | null
          consent_given?: boolean
          consent_given_at?: string | null
          created_at?: string
          email: string
          enrolled_at?: string
          first_name?: string | null
          id?: string
          influencer_referral_rate?: number | null
          is_blocked?: boolean
          is_influencer?: boolean
          last_name?: string | null
          lifetime_spend_pkr?: number
          points_balance?: number
          referral_slug: string
          referred_by_member_id?: string | null
          shopify_customer_id: string
          tier?: string
          updated_at?: string
        }
        Update: {
          birthday_day?: number | null
          birthday_month?: number | null
          consent_given?: boolean
          consent_given_at?: string | null
          created_at?: string
          email?: string
          enrolled_at?: string
          first_name?: string | null
          id?: string
          influencer_referral_rate?: number | null
          is_blocked?: boolean
          is_influencer?: boolean
          last_name?: string | null
          lifetime_spend_pkr?: number
          points_balance?: number
          referral_slug?: string
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
      order_webhook_state: {
        Row: {
          created_at: string
          financial_status: string | null
          fulfillment_status: string | null
          id: string
          order_total_pkr: number | null
          points_awarded: boolean
          shopify_customer_id: string | null
          shopify_order_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          financial_status?: string | null
          fulfillment_status?: string | null
          id?: string
          order_total_pkr?: number | null
          points_awarded?: boolean
          shopify_customer_id?: string | null
          shopify_order_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          financial_status?: string | null
          fulfillment_status?: string | null
          id?: string
          order_total_pkr?: number | null
          points_awarded?: boolean
          shopify_customer_id?: string | null
          shopify_order_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      points_ledger: {
        Row: {
          action_type: string
          balance_after: number
          earned_at: string
          expired: boolean
          expires_at: string | null
          id: string
          member_id: string
          points: number
          reason_note: string | null
          reference_id: string | null
          shopify_order_id: string | null
        }
        Insert: {
          action_type: string
          balance_after: number
          earned_at?: string
          expired?: boolean
          expires_at?: string | null
          id?: string
          member_id: string
          points: number
          reason_note?: string | null
          reference_id?: string | null
          shopify_order_id?: string | null
        }
        Update: {
          action_type?: string
          balance_after?: number
          earned_at?: string
          expired?: boolean
          expires_at?: string | null
          id?: string
          member_id?: string
          points?: number
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
          id: string
          points_awarded: boolean
          referred_email: string
          referred_ip: string | null
          referred_shopify_customer_id: string | null
          referrer_ip: string | null
          referrer_member_id: string
          shopify_order_id: string | null
          status: string
        }
        Insert: {
          block_reason?: string | null
          completed_at?: string | null
          created_at?: string
          id?: string
          points_awarded?: boolean
          referred_email: string
          referred_ip?: string | null
          referred_shopify_customer_id?: string | null
          referrer_ip?: string | null
          referrer_member_id: string
          shopify_order_id?: string | null
          status?: string
        }
        Update: {
          block_reason?: string | null
          completed_at?: string | null
          created_at?: string
          id?: string
          points_awarded?: boolean
          referred_email?: string
          referred_ip?: string | null
          referred_shopify_customer_id?: string | null
          referrer_ip?: string | null
          referrer_member_id?: string
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
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
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
