output "server_public_ip" {
  value = oci_core_instance.node["server"].public_ip
}

output "agent_public_ip" {
  value = oci_core_instance.node["agent"].public_ip
}

output "node_private_ips" {
  value = { for k, n in oci_core_instance.node : k => n.private_ip }
}

output "node_cidr" {
  description = "Put this in deploy/helm/labforge/values-prod.yaml network.nodeCidr."
  value       = var.subnet_cidr
}

# Ansible inventory straight from the real addresses (git-ignored).
resource "local_file" "ansible_inventory" {
  filename        = "${path.module}/../ansible/inventory.ini"
  file_permission = "0644"
  content = templatefile("${path.module}/inventory.tftpl", {
    server_public  = oci_core_instance.node["server"].public_ip
    server_private = oci_core_instance.node["server"].private_ip
    agent_public   = oci_core_instance.node["agent"].public_ip
    agent_private  = oci_core_instance.node["agent"].private_ip
    node_cidr      = var.subnet_cidr
  })
}
