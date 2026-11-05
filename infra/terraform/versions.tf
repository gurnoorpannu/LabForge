terraform {
  # 1.12 added the native "oci" backend used for remote state.
  required_version = ">= 1.12.0"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 9.12"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }

  # State in OCI Object Storage. Partial config: the bucket/namespace live in
  # backend.hcl (git-ignored; copy backend.hcl.example). Create the bucket once
  # first, see infra/README.md.
  backend "oci" {}
}

# Credentials come from ~/.oci/config (`oci setup config`), never from tfvars.
provider "oci" {
  config_file_profile = var.oci_profile
  region              = var.region
}
