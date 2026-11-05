variable "oci_profile" {
  description = "Profile in ~/.oci/config to authenticate with."
  type        = string
  default     = "DEFAULT"
}

variable "region" {
  description = "OCI region, e.g. ap-mumbai-1. Must be your tenancy's home region for Always Free A1."
  type        = string
}

variable "tenancy_ocid" {
  description = "Tenancy OCID (used to look up availability domains)."
  type        = string
}

variable "compartment_ocid" {
  description = "Compartment to create everything in (the tenancy OCID works for a personal account)."
  type        = string
}

variable "admin_ip" {
  description = "Your public IP as /32. The only source allowed to reach SSH (22) and the Kubernetes API (6443)."
  type        = string

  validation {
    condition     = can(cidrhost(var.admin_ip, 0)) && endswith(var.admin_ip, "/32")
    error_message = "admin_ip must be a single address in CIDR form, e.g. 203.0.113.7/32."
  }
}

variable "ssh_public_key_path" {
  description = "Public key installed for the ubuntu user on both nodes."
  type        = string
  default     = "~/.ssh/id_ed25519.pub"
}

variable "vcn_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "subnet_cidr" {
  description = "Node subnet. Must match network.nodeCidr in deploy/helm/labforge/values-prod.yaml."
  type        = string
  default     = "10.0.1.0/24"
}

variable "availability_domain_index" {
  description = "Which AD to use. If A1 says 'Out of host capacity', try another index (or later)."
  type        = number
  default     = 0
}

# Always Free (2026): 4 Ampere A1 OCPUs + 24 GB RAM + 200 GB block storage per
# tenancy. Two 2-OCPU/12-GB nodes with 50 GB boot volumes stay inside it.
variable "node_ocpus" {
  type    = number
  default = 2
}

variable "node_memory_gb" {
  type    = number
  default = 12
}

variable "boot_volume_gb" {
  type    = number
  default = 50
}
