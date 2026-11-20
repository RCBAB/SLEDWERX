
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "audit_log": {
                  Row: {
                    "action": string,"actor_id": string | null,"category": string,"changed_fields": (string)[] | null,"garage_id": string | null,"id": number,"library_owner_id": string | null,"new_data": Json | null,"occurred_at": string,"old_data": Json | null,"record_created_by": string | null,"record_id": string,"sled_id": string | null,"table_name": string
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor_id"?: string | null,"category": string,"changed_fields"?: (string)[] | null,"garage_id"?: string | null,"id"?: never,"library_owner_id"?: string | null,"new_data"?: Json | null,"occurred_at"?: string,"old_data"?: Json | null,"record_created_by"?: string | null,"record_id": string,"sled_id"?: string | null,"table_name": string
                  }
                  Update: {
                    "action"?: string,"actor_id"?: string | null,"category"?: string,"changed_fields"?: (string)[] | null,"garage_id"?: string | null,"id"?: never,"library_owner_id"?: string | null,"new_data"?: Json | null,"occurred_at"?: string,"old_data"?: Json | null,"record_created_by"?: string | null,"record_id"?: string,"sled_id"?: string | null,"table_name"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "audit_log_garage_id_fkey"
      columns: ["garage_id"]
isOneToOne: false
      referencedRelation: "garages"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "audit_log_sled_id_fkey"
      columns: ["sled_id"]
isOneToOne: false
      referencedRelation: "sleds"
      referencedColumns: ["id"]
    }
                  ]
                },"garages": {
                  Row: {
                    "created_at": string,"created_by": string | null,"deleted_at": string | null,"deleted_by": string | null,"id": string,"is_default": boolean,"name": string,"owner_id": string,"updated_at": string,"updated_by": string | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"id"?: string,"is_default"?: boolean,"name": string,"owner_id"?: string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"id"?: string,"is_default"?: boolean,"name"?: string,"owner_id"?: string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Relationships: [
                    
                  ]
                },"maintenance_entries": {
                  Row: {
                    "category": string | null,"client_request_id": string | null,"completed": boolean,"created_at": string,"created_by": string | null,"deleted_at": string | null,"deleted_by": string | null,"done_by": string | null,"edited_at": string | null,"id": string,"labor_cost": number | null,"notes": string | null,"other_cost": number | null,"performed_on": string,"reading_id": string | null,"sled_id": string,"title": string,"updated_at": string,"updated_by": string | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "category"?: string | null,"client_request_id"?: string | null,"completed"?: boolean,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"done_by"?: string | null,"edited_at"?: string | null,"id"?: string,"labor_cost"?: number | null,"notes"?: string | null,"other_cost"?: number | null,"performed_on": string,"reading_id"?: string | null,"sled_id": string,"title": string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Update: {
                    "category"?: string | null,"client_request_id"?: string | null,"completed"?: boolean,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"done_by"?: string | null,"edited_at"?: string | null,"id"?: string,"labor_cost"?: number | null,"notes"?: string | null,"other_cost"?: number | null,"performed_on"?: string,"reading_id"?: string | null,"sled_id"?: string,"title"?: string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "maintenance_entries_reading_id_fkey"
      columns: ["reading_id"]
isOneToOne: false
      referencedRelation: "sled_reading_history"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "maintenance_entries_reading_id_fkey"
      columns: ["reading_id"]
isOneToOne: false
      referencedRelation: "sled_readings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "maintenance_entries_sled_id_fkey"
      columns: ["sled_id"]
isOneToOne: false
      referencedRelation: "sleds"
      referencedColumns: ["id"]
    }
                  ]
                },"maintenance_entry_parts": {
                  Row: {
                    "brand": string | null,"created_at": string,"created_by": string | null,"deleted_at": string | null,"deleted_by": string | null,"entry_id": string,"id": string,"name": string,"note": string | null,"part_number": string | null,"quantity": number,"sled_id": string,"supplier": string | null,"unit_cost": number | null,"updated_at": string,"updated_by": string | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "brand"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"entry_id": string,"id"?: string,"name": string,"note"?: string | null,"part_number"?: string | null,"quantity"?: number,"sled_id": string,"supplier"?: string | null,"unit_cost"?: number | null,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Update: {
                    "brand"?: string | null,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"entry_id"?: string,"id"?: string,"name"?: string,"note"?: string | null,"part_number"?: string | null,"quantity"?: number,"sled_id"?: string,"supplier"?: string | null,"unit_cost"?: number | null,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "maintenance_entry_parts_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "maintenance_entries"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "maintenance_entry_parts_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "maintenance_entry_costs"
      referencedColumns: ["entry_id"]
    },{
      foreignKeyName: "maintenance_entry_parts_sled_id_fkey"
      columns: ["sled_id"]
isOneToOne: false
      referencedRelation: "sleds"
      referencedColumns: ["id"]
    }
                  ]
                },"maintenance_entry_tasks": {
                  Row: {
                    "created_at": string,"created_by": string | null,"deleted_at": string | null,"deleted_by": string | null,"done": boolean,"entry_id": string,"id": string,"note": string | null,"position": number,"sled_id": string,"task_id": string | null,"task_name": string,"updated_at": string,"updated_by": string | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"done"?: boolean,"entry_id": string,"id"?: string,"note"?: string | null,"position"?: number,"sled_id": string,"task_id"?: string | null,"task_name": string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"done"?: boolean,"entry_id"?: string,"id"?: string,"note"?: string | null,"position"?: number,"sled_id"?: string,"task_id"?: string | null,"task_name"?: string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "maintenance_entry_tasks_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "maintenance_entries"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "maintenance_entry_tasks_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "maintenance_entry_costs"
      referencedColumns: ["entry_id"]
    },{
      foreignKeyName: "maintenance_entry_tasks_sled_id_fkey"
      columns: ["sled_id"]
isOneToOne: false
      referencedRelation: "sleds"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "maintenance_entry_tasks_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "maintenance_tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"maintenance_package_tasks": {
                  Row: {
                    "created_at": string,"created_by": string | null,"deleted_at": string | null,"deleted_by": string | null,"id": string,"owner_id": string,"package_id": string,"position": number,"task_id": string,"updated_at": string,"updated_by": string | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"id"?: string,"owner_id": string,"package_id": string,"position"?: number,"task_id": string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"id"?: string,"owner_id"?: string,"package_id"?: string,"position"?: number,"task_id"?: string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "maintenance_package_tasks_package_id_fkey"
      columns: ["package_id"]
isOneToOne: false
      referencedRelation: "maintenance_packages"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "maintenance_package_tasks_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "maintenance_tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"maintenance_packages": {
                  Row: {
                    "created_at": string,"created_by": string | null,"deleted_at": string | null,"deleted_by": string | null,"id": string,"name": string,"notes": string | null,"owner_id": string,"updated_at": string,"updated_by": string | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"id"?: string,"name": string,"notes"?: string | null,"owner_id"?: string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"id"?: string,"name"?: string,"notes"?: string | null,"owner_id"?: string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Relationships: [
                    
                  ]
                },"maintenance_plans": {
                  Row: {
                    "created_at": string,"created_by": string | null,"deleted_at": string | null,"deleted_by": string | null,"id": string,"interval_days": number | null,"interval_hours": number | null,"interval_mi": number | null,"last_done_hours": number | null,"last_done_mi": number | null,"last_done_on": string | null,"notes": string | null,"paused": boolean,"season_due_day": number | null,"season_due_month": number | null,"sled_id": string,"task_id": string,"updated_at": string,"updated_by": string | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"id"?: string,"interval_days"?: number | null,"interval_hours"?: number | null,"interval_mi"?: number | null,"last_done_hours"?: number | null,"last_done_mi"?: number | null,"last_done_on"?: string | null,"notes"?: string | null,"paused"?: boolean,"season_due_day"?: number | null,"season_due_month"?: number | null,"sled_id": string,"task_id": string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"id"?: string,"interval_days"?: number | null,"interval_hours"?: number | null,"interval_mi"?: number | null,"last_done_hours"?: number | null,"last_done_mi"?: number | null,"last_done_on"?: string | null,"notes"?: string | null,"paused"?: boolean,"season_due_day"?: number | null,"season_due_month"?: number | null,"sled_id"?: string,"task_id"?: string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "maintenance_plans_sled_id_fkey"
      columns: ["sled_id"]
isOneToOne: false
      referencedRelation: "sleds"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "maintenance_plans_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "maintenance_tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"maintenance_tasks": {
                  Row: {
                    "created_at": string,"created_by": string | null,"deleted_at": string | null,"deleted_by": string | null,"id": string,"name": string,"notes": string | null,"owner_id": string | null,"sled_id": string | null,"updated_at": string,"updated_by": string | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"id"?: string,"name": string,"notes"?: string | null,"owner_id"?: string | null,"sled_id"?: string | null,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"id"?: string,"name"?: string,"notes"?: string | null,"owner_id"?: string | null,"sled_id"?: string | null,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "maintenance_tasks_sled_id_fkey"
      columns: ["sled_id"]
isOneToOne: false
      referencedRelation: "sleds"
      referencedColumns: ["id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "created_at": string,"created_by": string | null,"display_name": string | null,"id": string,"updated_at": string,"updated_by": string | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"display_name"?: string | null,"id": string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"display_name"?: string | null,"id"?: string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Relationships: [
                    
                  ]
                },"sled_invitations": {
                  Row: {
                    "accepted_at": string | null,"accepted_by": string | null,"created_at": string,"created_by": string | null,"email": string,"expires_at": string,"id": string,"revoked_at": string | null,"revoked_by": string | null,"role": Database["public"]['Enums']["sled_share_role"],"sled_id": string,"token_hash": string,"updated_at": string,"updated_by": string | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"created_at"?: string,"created_by"?: string | null,"email": string,"expires_at": string,"id"?: string,"revoked_at"?: string | null,"revoked_by"?: string | null,"role": Database["public"]['Enums']["sled_share_role"],"sled_id": string,"token_hash": string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Update: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"created_at"?: string,"created_by"?: string | null,"email"?: string,"expires_at"?: string,"id"?: string,"revoked_at"?: string | null,"revoked_by"?: string | null,"role"?: Database["public"]['Enums']["sled_share_role"],"sled_id"?: string,"token_hash"?: string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "sled_invitations_sled_id_fkey"
      columns: ["sled_id"]
isOneToOne: false
      referencedRelation: "sleds"
      referencedColumns: ["id"]
    }
                  ]
                },"sled_issue_photos": {
                  Row: {
                    "created_at": string,"created_by": string | null,"deleted_at": string | null,"deleted_by": string | null,"id": string,"issue_id": string,"path": string,"position": number,"sled_id": string,"updated_at": string,"updated_by": string | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"id"?: string,"issue_id": string,"path": string,"position"?: number,"sled_id": string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"id"?: string,"issue_id"?: string,"path"?: string,"position"?: number,"sled_id"?: string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "sled_issue_photos_issue_id_fkey"
      columns: ["issue_id"]
isOneToOne: false
      referencedRelation: "sled_issues"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "sled_issue_photos_sled_id_fkey"
      columns: ["sled_id"]
isOneToOne: false
      referencedRelation: "sleds"
      referencedColumns: ["id"]
    }
                  ]
                },"sled_issues": {
                  Row: {
                    "created_at": string,"created_by": string | null,"deleted_at": string | null,"deleted_by": string | null,"description": string | null,"id": string,"odometer_mi": number | null,"priority": string,"reported_on": string,"resolution_notes": string | null,"resolved_by": string | null,"resolved_entry_id": string | null,"resolved_on": string | null,"sled_id": string,"status": string,"title": string,"updated_at": string,"updated_by": string | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"description"?: string | null,"id"?: string,"odometer_mi"?: number | null,"priority"?: string,"reported_on"?: string,"resolution_notes"?: string | null,"resolved_by"?: string | null,"resolved_entry_id"?: string | null,"resolved_on"?: string | null,"sled_id": string,"status"?: string,"title": string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"description"?: string | null,"id"?: string,"odometer_mi"?: number | null,"priority"?: string,"reported_on"?: string,"resolution_notes"?: string | null,"resolved_by"?: string | null,"resolved_entry_id"?: string | null,"resolved_on"?: string | null,"sled_id"?: string,"status"?: string,"title"?: string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "sled_issues_resolved_entry_id_fkey"
      columns: ["resolved_entry_id"]
isOneToOne: false
      referencedRelation: "maintenance_entries"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "sled_issues_resolved_entry_id_fkey"
      columns: ["resolved_entry_id"]
isOneToOne: false
      referencedRelation: "maintenance_entry_costs"
      referencedColumns: ["entry_id"]
    },{
      foreignKeyName: "sled_issues_sled_id_fkey"
      columns: ["sled_id"]
isOneToOne: false
      referencedRelation: "sleds"
      referencedColumns: ["id"]
    }
                  ]
                },"sled_readings": {
                  Row: {
                    "created_at": string,"created_by": string | null,"deleted_at": string | null,"deleted_by": string | null,"engine_event": Database["public"]['Enums']["engine_event"] | null,"engine_hours": number | null,"hour_meter_reset": boolean,"id": string,"note": string | null,"odometer_mi": number | null,"odometer_reset": boolean,"read_on": string,"sled_id": string,"updated_at": string,"updated_by": string | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"engine_event"?: Database["public"]['Enums']["engine_event"] | null,"engine_hours"?: number | null,"hour_meter_reset"?: boolean,"id"?: string,"note"?: string | null,"odometer_mi"?: number | null,"odometer_reset"?: boolean,"read_on": string,"sled_id": string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"engine_event"?: Database["public"]['Enums']["engine_event"] | null,"engine_hours"?: number | null,"hour_meter_reset"?: boolean,"id"?: string,"note"?: string | null,"odometer_mi"?: number | null,"odometer_reset"?: boolean,"read_on"?: string,"sled_id"?: string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "sled_readings_sled_id_fkey"
      columns: ["sled_id"]
isOneToOne: false
      referencedRelation: "sleds"
      referencedColumns: ["id"]
    }
                  ]
                },"sled_shares": {
                  Row: {
                    "created_at": string,"created_by": string | null,"id": string,"invitation_id": string | null,"revoked_at": string | null,"revoked_by": string | null,"role": Database["public"]['Enums']["sled_share_role"],"sled_id": string,"suspended_at": string | null,"updated_at": string,"updated_by": string | null,"user_id": string,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"invitation_id"?: string | null,"revoked_at"?: string | null,"revoked_by"?: string | null,"role": Database["public"]['Enums']["sled_share_role"],"sled_id": string,"suspended_at"?: string | null,"updated_at"?: string,"updated_by"?: string | null,"user_id": string,"version"?: number
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"invitation_id"?: string | null,"revoked_at"?: string | null,"revoked_by"?: string | null,"role"?: Database["public"]['Enums']["sled_share_role"],"sled_id"?: string,"suspended_at"?: string | null,"updated_at"?: string,"updated_by"?: string | null,"user_id"?: string,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "sled_shares_sled_id_fkey"
      columns: ["sled_id"]
isOneToOne: false
      referencedRelation: "sleds"
      referencedColumns: ["id"]
    }
                  ]
                },"sled_suspension_state": {
                  Row: {
                    "active_revision_id": string | null,"carbide_length": string | null,"created_at": string,"created_by": string | null,"id": string,"ski_model": string | null,"sled_id": string,"updated_at": string,"updated_by": string | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "active_revision_id"?: string | null,"carbide_length"?: string | null,"created_at"?: string,"created_by"?: string | null,"id"?: string,"ski_model"?: string | null,"sled_id": string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Update: {
                    "active_revision_id"?: string | null,"carbide_length"?: string | null,"created_at"?: string,"created_by"?: string | null,"id"?: string,"ski_model"?: string | null,"sled_id"?: string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "sled_suspension_state_active_revision_id_fkey"
      columns: ["active_revision_id"]
isOneToOne: false
      referencedRelation: "suspension_revisions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "sled_suspension_state_sled_id_fkey"
      columns: ["sled_id"]
isOneToOne: true
      referencedRelation: "sleds"
      referencedColumns: ["id"]
    }
                  ]
                },"sleds": {
                  Row: {
                    "created_at": string,"created_by": string | null,"deleted_at": string | null,"deleted_by": string | null,"engine_description": string | null,"engine_displacement_cc": number | null,"garage_id": string,"id": string,"make": string,"model": string,"model_year": number,"nickname": string | null,"notes": string | null,"owner_id": string,"photo_path": string | null,"purchase_date": string | null,"status": Database["public"]['Enums']["sled_status"],"updated_at": string,"updated_by": string | null,"version": number,"vin": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"engine_description"?: string | null,"engine_displacement_cc"?: number | null,"garage_id": string,"id"?: string,"make": string,"model": string,"model_year": number,"nickname"?: string | null,"notes"?: string | null,"owner_id"?: string,"photo_path"?: string | null,"purchase_date"?: string | null,"status"?: Database["public"]['Enums']["sled_status"],"updated_at"?: string,"updated_by"?: string | null,"version"?: number,"vin"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"engine_description"?: string | null,"engine_displacement_cc"?: number | null,"garage_id"?: string,"id"?: string,"make"?: string,"model"?: string,"model_year"?: number,"nickname"?: string | null,"notes"?: string | null,"owner_id"?: string,"photo_path"?: string | null,"purchase_date"?: string | null,"status"?: Database["public"]['Enums']["sled_status"],"updated_at"?: string,"updated_by"?: string | null,"version"?: number,"vin"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "sleds_garage_id_fkey"
      columns: ["garage_id"]
isOneToOne: false
      referencedRelation: "garages"
      referencedColumns: ["id"]
    }
                  ]
                },"suspension_feedback": {
                  Row: {
                    "conditions": (string)[],"created_at": string,"created_by": string | null,"deleted_at": string | null,"deleted_by": string | null,"high_temp_f": number | null,"id": string,"note": string | null,"rating": string,"revision_id": string,"ridden_on": string,"sled_id": string,"updated_at": string,"updated_by": string | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "conditions"?: (string)[],"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"high_temp_f"?: number | null,"id"?: string,"note"?: string | null,"rating": string,"revision_id": string,"ridden_on"?: string,"sled_id": string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Update: {
                    "conditions"?: (string)[],"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"high_temp_f"?: number | null,"id"?: string,"note"?: string | null,"rating"?: string,"revision_id"?: string,"ridden_on"?: string,"sled_id"?: string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "suspension_feedback_revision_id_fkey"
      columns: ["revision_id"]
isOneToOne: false
      referencedRelation: "suspension_revisions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "suspension_feedback_sled_id_fkey"
      columns: ["sled_id"]
isOneToOne: false
      referencedRelation: "sleds"
      referencedColumns: ["id"]
    }
                  ]
                },"suspension_photos": {
                  Row: {
                    "created_at": string,"created_by": string | null,"deleted_at": string | null,"deleted_by": string | null,"id": string,"path": string,"position": number,"revision_id": string | null,"setting_id": string | null,"sled_id": string,"updated_at": string,"updated_by": string | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"id"?: string,"path": string,"position"?: number,"revision_id"?: string | null,"setting_id"?: string | null,"sled_id": string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"id"?: string,"path"?: string,"position"?: number,"revision_id"?: string | null,"setting_id"?: string | null,"sled_id"?: string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "suspension_photos_revision_id_fkey"
      columns: ["revision_id"]
isOneToOne: false
      referencedRelation: "suspension_revisions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "suspension_photos_setting_id_fkey"
      columns: ["setting_id"]
isOneToOne: false
      referencedRelation: "suspension_settings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "suspension_photos_sled_id_fkey"
      columns: ["sled_id"]
isOneToOne: false
      referencedRelation: "sleds"
      referencedColumns: ["id"]
    }
                  ]
                },"suspension_revisions": {
                  Row: {
                    "based_on_revision_id": string | null,"carbide_length": string | null,"client_request_id": string | null,"config_number": number,"created_at": string,"created_by": string | null,"deleted_at": string | null,"deleted_by": string | null,"engine_hours": number | null,"id": string,"note": string | null,"odometer_mi": number | null,"restored_from_revision_id": string | null,"revision_number": number,"setting_values": NonNullable<Json>,"setup_id": string,"ski_model": string | null,"sled_id": string,"updated_at": string,"updated_by": string | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "based_on_revision_id"?: string | null,"carbide_length"?: string | null,"client_request_id"?: string | null,"config_number": number,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"engine_hours"?: number | null,"id"?: string,"note"?: string | null,"odometer_mi"?: number | null,"restored_from_revision_id"?: string | null,"revision_number": number,"setting_values"?: NonNullable<Json>,"setup_id": string,"ski_model"?: string | null,"sled_id": string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Update: {
                    "based_on_revision_id"?: string | null,"carbide_length"?: string | null,"client_request_id"?: string | null,"config_number"?: number,"created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"engine_hours"?: number | null,"id"?: string,"note"?: string | null,"odometer_mi"?: number | null,"restored_from_revision_id"?: string | null,"revision_number"?: number,"setting_values"?: NonNullable<Json>,"setup_id"?: string,"ski_model"?: string | null,"sled_id"?: string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "suspension_revisions_restored_from_revision_id_fkey"
      columns: ["restored_from_revision_id"]
isOneToOne: false
      referencedRelation: "suspension_revisions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "suspension_revisions_setup_id_fkey"
      columns: ["setup_id"]
isOneToOne: false
      referencedRelation: "suspension_setups"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "suspension_revisions_sled_id_fkey"
      columns: ["sled_id"]
isOneToOne: false
      referencedRelation: "sleds"
      referencedColumns: ["id"]
    }
                  ]
                },"suspension_settings": {
                  Row: {
                    "created_at": string,"created_by": string | null,"deleted_at": string | null,"deleted_by": string | null,"id": string,"name": string,"notes": string | null,"position": number,"sled_id": string,"unit": string | null,"updated_at": string,"updated_by": string | null,"value_type": string,"version": number,"zone": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"id"?: string,"name": string,"notes"?: string | null,"position"?: number,"sled_id": string,"unit"?: string | null,"updated_at"?: string,"updated_by"?: string | null,"value_type"?: string,"version"?: number,"zone": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"id"?: string,"name"?: string,"notes"?: string | null,"position"?: number,"sled_id"?: string,"unit"?: string | null,"updated_at"?: string,"updated_by"?: string | null,"value_type"?: string,"version"?: number,"zone"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "suspension_settings_sled_id_fkey"
      columns: ["sled_id"]
isOneToOne: false
      referencedRelation: "sleds"
      referencedColumns: ["id"]
    }
                  ]
                },"suspension_setups": {
                  Row: {
                    "created_at": string,"created_by": string | null,"deleted_at": string | null,"deleted_by": string | null,"id": string,"is_active": boolean,"name": string,"notes": string | null,"sled_id": string,"updated_at": string,"updated_by": string | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"id"?: string,"is_active"?: boolean,"name": string,"notes"?: string | null,"sled_id": string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"deleted_at"?: string | null,"deleted_by"?: string | null,"id"?: string,"is_active"?: boolean,"name"?: string,"notes"?: string | null,"sled_id"?: string,"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "suspension_setups_sled_id_fkey"
      columns: ["sled_id"]
isOneToOne: false
      referencedRelation: "sleds"
      referencedColumns: ["id"]
    }
                  ]
                },"user_preferences": {
                  Row: {
                    "created_at": string,"created_by": string | null,"dashboard": NonNullable<Json>,"garage_mode": NonNullable<Json>,"id": string,"theme": Database["public"]['Enums']["theme_preference"],"updated_at": string,"updated_by": string | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"dashboard"?: NonNullable<Json>,"garage_mode"?: NonNullable<Json>,"id": string,"theme"?: Database["public"]['Enums']["theme_preference"],"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"dashboard"?: NonNullable<Json>,"garage_mode"?: NonNullable<Json>,"id"?: string,"theme"?: Database["public"]['Enums']["theme_preference"],"updated_at"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            "maintenance_board": {
                  Row: {
                    "baseline_hours": number | null,"baseline_mi": number | null,"baseline_on": string | null,"created_by": string | null,"current_hours": number | null,"current_mi": number | null,"due_hours": number | null,"due_mi": number | null,"due_on": string | null,"hours_unknown": boolean | null,"interval_days": number | null,"interval_hours": number | null,"interval_mi": number | null,"last_done_entry_id": string | null,"last_done_hours": number | null,"last_done_mi": number | null,"last_done_on": string | null,"last_done_source": string | null,"mileage_unknown": boolean | null,"notes": string | null,"paused": boolean,"plan_id": string,"remaining_days": number | null,"remaining_hours": number | null,"remaining_mi": number | null,"season_due_day": number | null,"season_due_month": number | null,"sled_id": string,"status": string | null,"status_rank": number | null,"task_id": string,"task_name": string,"urgency": number | null,"version": number,"warn_days": number | null,"warn_hours": number | null,"warn_mi": number | null,"warn_season_days": number | null
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "maintenance_plans_sled_id_fkey"
      columns: ["sled_id"]
isOneToOne: false
      referencedRelation: "sleds"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "maintenance_plans_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "maintenance_tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"maintenance_entry_costs": {
                  Row: {
                    "entry_id": string,"labor_cost": number | null,"other_cost": number | null,"parts_cost": number | null,"sled_id": string,"total_cost": number | null
                  }
                  ComputedFields: never
                  Insert: {
                           "entry_id"?: string | null,"labor_cost"?: never,"other_cost"?: never,"parts_cost"?: never,"sled_id"?: string | null,"total_cost"?: never
                         }
                        Update: {
                           "entry_id"?: string | null,"labor_cost"?: never,"other_cost"?: never,"parts_cost"?: never,"sled_id"?: string | null,"total_cost"?: never
                         }
                        Relationships: [
                    {
      foreignKeyName: "maintenance_entries_sled_id_fkey"
      columns: ["sled_id"]
isOneToOne: false
      referencedRelation: "sleds"
      referencedColumns: ["id"]
    }
                  ]
                },"sled_reading_history": {
                  Row: {
                    "created_at": string,"created_by": string | null,"engine_event": Database["public"]['Enums']["engine_event"] | null,"engine_hours": number | null,"hour_meter_reset": boolean,"id": string,"note": string | null,"odometer_mi": number | null,"odometer_reset": boolean,"read_on": string,"sled_id": string,"total_engine_hours": number | null,"total_mi": number | null,"version": number
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "sled_readings_sled_id_fkey"
      columns: ["sled_id"]
isOneToOne: false
      referencedRelation: "sleds"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Functions: {
            "accept_sled_invitation":
{ Args: { "p_token": string }; Returns: string
                           },
"activate_suspension_configuration":
{ Args: { "p_equipment_installed"?: boolean,"p_revision_id": string }; Returns: Json
                           },
"activate_suspension_setup":
{ Args: { "p_setup_id": string }; Returns: undefined
                           },
"cleanup_begin_run":
{ Args: { "p_mode": string }; Returns: number
                           },
"cleanup_claim_file":
{ Args: { "p_bucket_id": string,"p_object_path": string,"p_run_id": number }; Returns: Json
                           },
"cleanup_dashboard":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"cleanup_eligible_files":
{ Args: { "p_run_id": number }; Returns: {
              "bucket_id": string,"object_path": string
            }[]
                           },
"cleanup_finish_run":
{ Args: { "p_error"?: string,"p_run_id": number }; Returns: Json
                           },
"cleanup_process_records":
{ Args: { "p_run_id": number }; Returns: Json
                           },
"cleanup_record_file_result":
{ Args: { "p_bucket_id": string,"p_deleted_object"?: Json,"p_error"?: string,"p_object_path": string,"p_removed": boolean,"p_run_id": number }; Returns: Json
                           },
"cleanup_report_files":
{ Args: { "p_run_id": number }; Returns: Json
                           },
"cleanup_retention":
{ Args: { "p_run_id": number }; Returns: Json
                           },
"cleanup_verify_claim":
{ Args: { "p_bucket_id": string,"p_object_path": string,"p_run_id": number }; Returns: Json
                           },
"create_sled":
{ Args: { "p_engine_hours"?: number,"p_garage_id"?: string,"p_make": string,"p_model": string,"p_model_year": number,"p_nickname"?: string,"p_odometer_mi": number,"p_read_on"?: string,"p_vin"?: string }; Returns: string
                           },
"create_sled_invitation":
{ Args: { "p_email": string,"p_expires_in_days"?: number,"p_role": Database["public"]['Enums']["sled_share_role"],"p_sled_id": string }; Returns: {
              "expires_at": string,"invitation_id": string,"token": string
            }[]
                           },
"create_suspension_setup":
{ Args: { "p_copy_from_revision_id"?: string,"p_name": string,"p_notes"?: string,"p_sled_id": string }; Returns: Json
                           },
"permanently_delete_sled":
{ Args: { "p_sled_id": string }; Returns: undefined
                           },
"reactivate_sled_share":
{ Args: { "p_share_id": string }; Returns: undefined
                           },
"restore_record_version":
{ Args: { "p_audit_id": number }; Returns: undefined
                           },
"restore_suspension_revision":
{ Args: { "p_engine_hours"?: number,"p_idempotency_key"?: string,"p_note"?: string,"p_odometer_mi"?: number,"p_revision_id": string }; Returns: Json
                           },
"revoke_sled_invitation":
{ Args: { "p_invitation_id": string }; Returns: undefined
                           },
"revoke_sled_share":
{ Args: { "p_share_id": string }; Returns: undefined
                           },
"save_maintenance_entry":
{ Args: { "p_category"?: string,"p_completed"?: boolean,"p_done_by"?: string,"p_idempotency_key": string,"p_labor_cost"?: number,"p_notes"?: string,"p_other_cost"?: number,"p_parts"?: Json,"p_performed_on": string,"p_reading"?: Json,"p_sled_id": string,"p_tasks"?: Json,"p_title": string }; Returns: Json
                           },
"save_suspension_configuration":
{ Args: { "p_base_revision_id"?: string,"p_carbide_length"?: string,"p_changes"?: Json,"p_engine_hours"?: number,"p_idempotency_key"?: string,"p_note"?: string,"p_odometer_mi"?: number,"p_ski_model"?: string,"p_sled_id": string }; Returns: Json
                           },
"save_suspension_revision":
{ Args: { "p_base_revision_id": string,"p_changes": Json,"p_engine_hours"?: number,"p_idempotency_key"?: string,"p_note"?: string,"p_odometer_mi"?: number,"p_setup_id": string }; Returns: Json
                           },
"update_maintenance_entry":
{ Args: { "p_category"?: string,"p_done_by"?: string,"p_entry_id": string,"p_labor_cost"?: number,"p_notes"?: string,"p_other_cost"?: number,"p_parts"?: Json,"p_performed_on": string,"p_reading"?: Json,"p_tasks"?: Json,"p_title": string,"p_version": number }; Returns: Json
                           },
"update_sled_share_role":
{ Args: { "p_role": Database["public"]['Enums']["sled_share_role"],"p_share_id": string }; Returns: undefined
                           }
          }
          Enums: {
            "engine_event": "engine_replaced"|"engine_rebuilt","sled_share_role": "editor"|"mechanic"|"viewer","sled_status": "ready"|"needs_attention"|"out_of_service"|"stored","theme_preference": "dark"|"light"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

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
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
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
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            "engine_event": ["engine_replaced", "engine_rebuilt"],"sled_share_role": ["editor", "mechanic", "viewer"],"sled_status": ["ready", "needs_attention", "out_of_service", "stored"],"theme_preference": ["dark", "light"]
          }
        }
} as const
