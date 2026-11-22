# The Booking Agent on Cloud Run, with Firestore, as Terraform: the same thing
# hosts/cloudrun.md's gcloud recipe makes. Written for the user to review and
# apply themselves; `terraform validate` passes, nothing here has been applied.
#
# It assumes the image is already in Artifact Registry, and the three secrets
# already exist with a version each (their values never go in Terraform state:
# create them with `gcloud secrets create … --data-file=-`). The front door —
# the load balancer's serverless NEG or Firebase Hosting's rewrites — is the
# site's, and stays where the site manages it.

terraform {
  required_providers {
    # Validated against 8.9.0.
    google = {
      source  = "hashicorp/google"
      version = "~> 8.9"
    }
  }
}

variable "project" { type = string }
variable "region" {
  type    = string
  default = "us-central1"
}
variable "image" { type = string }         # REGION-docker.pkg.dev/PROJECT/REPO/booking-agent:TAG
variable "public_origin" { type = string } # https://example.com
variable "sink_url" { type = string }      # https://example.com/api/book
variable "availability_url" { type = string } # https://example.com/api/slots

locals {
  database = "booking-agent"
  # Collections whose documents carry `expireAt`, for the TTL policies.
  collections = ["booking-tasks", "booking-progress", "booking-sent"]
  secrets = {
    A2A_RELAY_TOKEN             = "booking-relay-token"
    ANTHROPIC_API_KEY           = "booking-anthropic-key"
    NXIS_WEBHOOK_SIGNING_SECRET = "booking-sink-signing-secret"
  }
}

provider "google" {
  project = var.project
  region  = var.region
}

# ── Firestore (Native mode) ─────────────────────────────────────────────────
# A named database, so the agent's access can be scoped to it alone. Its
# location is permanent: the Cloud Run region, or the multi-region holding it.
resource "google_firestore_database" "booking" {
  name        = local.database
  location_id = var.region
  type        = "FIRESTORE_NATIVE"
}

resource "google_firestore_field" "ttl" {
  for_each   = toset(local.collections)
  database   = google_firestore_database.booking.name
  collection = each.value
  field      = "expireAt"
  ttl_config {}
  # TTL only: no single-field index on expireAt is needed.
  index_config {}
}

# ── The runtime identity, least privilege ───────────────────────────────────
resource "google_service_account" "booking" {
  account_id   = "booking-agent"
  display_name = "Booking Agent (Cloud Run runtime)"
}

# Read and write documents in the booking-agent database only.
resource "google_project_iam_member" "firestore" {
  project = var.project
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.booking.email}"
  condition {
    title      = "booking-agent database only"
    expression = "resource.name == \"projects/${var.project}/databases/${local.database}\""
  }
}

# Each secret, and nothing else in Secret Manager.
resource "google_secret_manager_secret_iam_member" "access" {
  for_each  = local.secrets
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.booking.email}"
}

# ── The service ─────────────────────────────────────────────────────────────
resource "google_cloud_run_v2_service" "booking" {
  name     = "booking-agent"
  location = var.region
  # Only the load balancer reaches it. With Firebase Hosting rewrites or an
  # own-origin URL instead, INGRESS_TRAFFIC_ALL.
  ingress = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  # The relay's bearer token is the defense, as on Docker: Cloud Run's IAM
  # check would want its own token in the same Authorization header.
  invoker_iam_disabled = true
  deletion_protection  = false

  template {
    service_account                  = google_service_account.booking.email
    timeout                          = "60s"
    max_instance_request_concurrency = 40
    scaling {
      min_instance_count = 0 # scale to zero: no cost while idle, a cold start after
      max_instance_count = 3 # a ceiling on spend
    }

    containers {
      image = var.image
      ports {
        container_port = 4120
      }
      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true # CPU only during requests (request-based billing)
        startup_cpu_boost = true
      }

      env {
        name  = "PUBLIC_ORIGIN"
        value = var.public_origin
      }
      env {
        name  = "BOOKING_SINK_URL"
        value = var.sink_url
      }
      env {
        name  = "BOOKING_AVAILABILITY_URL"
        value = var.availability_url
      }
      env {
        name  = "FIRESTORE_DATABASE"
        value = local.database
      }
      dynamic "env" {
        for_each = local.secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      startup_probe {
        http_get {
          path = "/healthz"
          port = 4120
        }
        period_seconds    = 2
        timeout_seconds   = 2
        failure_threshold = 15
      }
    }
  }

  depends_on = [google_project_iam_member.firestore, google_secret_manager_secret_iam_member.access]
}

output "url" { value = google_cloud_run_v2_service.booking.uri }
