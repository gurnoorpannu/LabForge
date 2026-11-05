resource "oci_core_vcn" "labforge" {
  compartment_id = var.compartment_ocid
  cidr_blocks    = [var.vcn_cidr]
  display_name   = "labforge"
  dns_label      = "labforge"
}

resource "oci_core_internet_gateway" "labforge" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.labforge.id
  display_name   = "labforge-igw"
  enabled        = true
}

resource "oci_core_route_table" "public" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.labforge.id
  display_name   = "labforge-public"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.labforge.id
  }
}

locals {
  tcp  = "6"
  icmp = "1"
  # Port -> allowed source. Everything else from outside the subnet is dropped.
  public_tcp = {
    "80"   = "0.0.0.0/0"  # HTTP (redirects to HTTPS; ACME HTTP-01)
    "443"  = "0.0.0.0/0"  # HTTPS: UI, API, labs
    "22"   = var.admin_ip # SSH
    "6443" = var.admin_ip # Kubernetes API (kubectl, ArgoCD CLI)
  }
}

resource "oci_core_security_list" "nodes" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.labforge.id
  display_name   = "labforge-nodes"

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }

  dynamic "ingress_security_rules" {
    for_each = local.public_tcp
    content {
      protocol = local.tcp
      source   = ingress_security_rules.value
      tcp_options {
        min = tonumber(ingress_security_rules.key)
        max = tonumber(ingress_security_rules.key)
      }
    }
  }

  # Node to node: flannel VXLAN (8472/udp), kubelet (10250), API (6443), etc.
  ingress_security_rules {
    protocol = "all"
    source   = var.subnet_cidr
  }

  # Path MTU discovery ("fragmentation needed"); blocking it breaks large packets.
  ingress_security_rules {
    protocol = local.icmp
    source   = "0.0.0.0/0"
    icmp_options {
      type = 3
      code = 4
    }
  }
}

resource "oci_core_subnet" "nodes" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.labforge.id
  cidr_block                 = var.subnet_cidr
  display_name               = "labforge-nodes"
  dns_label                  = "nodes"
  route_table_id             = oci_core_route_table.public.id
  security_list_ids          = [oci_core_security_list.nodes.id]
  prohibit_public_ip_on_vnic = false
}
