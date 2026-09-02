# Demo domains and DNS

This document defines the public hostnames needed for the hosted Waypoint demo.
It is provider-neutral: replace `domain.com` and `<reserved-server-IP>` with the
real values selected for the environment.

For the complete plan to replace the IP-based Door system, see
[`Demo-Auth.MD`](Demo-Auth.MD).

## Why use stable domains

The current demo URLs contain a numeric server IP through `sslip.io`. That ties
the deployed mobile configuration to one machine. A stable domain separates
the public address of the product from the server currently hosting it.

With stable domains:

- Salespeople never need to know the server IP.
- TestFlight builds contain durable HTTPS URLs.
- Moving to another server changes DNS rather than requiring a new mobile build.
- Caddy or another ingress can route several applications through one public
  IP address.
- The visitor-IP allowlist and Door system can be retired separately.

A domain does not itself remove Door. DNS solves the stable server-address
problem; removing the visitor IP allowlist solves the Door access problem.

## Required hostnames

Assuming the main name is `waypoint.domain.com`, use these four HTTPS origins:

| Hostname | Purpose | Internal destination |
|---|---|---|
| `waypoint.domain.com` | Waypoint API, learner site and LMS console | Waypoint `:8090` |
| `northwood.waypoint.domain.com` | Northwood staff web application and API | Northwood `:8092` |
| `content.waypoint.domain.com` | SCORM player and course package files | Content `:8091` |
| `control.waypoint.domain.com` | Sales Demo Control and baseline reset | Demo Control `:8099` |

All four names may resolve to the same server or load balancer. Their different
hostnames allow the HTTPS proxy to route each request to the correct process.

### The content hostname is mandatory

`content.waypoint.domain.com` must remain a different origin from
`waypoint.domain.com`, even when both use the same IP address. Uploaded SCORM
packages are third-party JavaScript. Serving them from the application origin
would allow course code to interact with application cookies and sessions.

Do not collapse the content hostname into a path such as
`waypoint.domain.com/content`.

## Recommended DNS records

For one server with a reserved public IPv4 address:

| Type | Name in the `domain.com` zone | Value |
|---|---|---|
| `A` | `waypoint` | `<reserved-server-IP>` |
| `CNAME` | `northwood.waypoint` | `waypoint.domain.com` |
| `CNAME` | `content.waypoint` | `waypoint.domain.com` |
| `CNAME` | `control.waypoint` | `waypoint.domain.com` |

Some DNS providers require a trailing dot on a fully qualified CNAME target:

```text
waypoint.domain.com.
```

The trailing dot is DNS notation, not part of the URL.

### Alternative: four A records

Four `A` records pointing to the same reserved IP also work:

```text
waypoint.domain.com             A  <reserved-server-IP>
northwood.waypoint.domain.com   A  <reserved-server-IP>
content.waypoint.domain.com     A  <reserved-server-IP>
control.waypoint.domain.com     A  <reserved-server-IP>
```

Using one `A` record plus three CNAME records is easier to maintain: a server
move requires changing one record.

### Managed ingress or load balancer

If the hosting platform provides a stable hostname instead of a reserved IP,
point the public names at that hostname with CNAME/alias records according to
the provider's instructions. Do not copy an ephemeral container or VM address
into TestFlight configuration.

## Records that are not needed

- Do not add an `AAAA` record unless the server, proxy and firewall have been
  deliberately configured and tested for IPv6.
- No `MX` records are needed; these hostnames do not receive email.
- No `SRV` records are needed.
- No wildcard record is required. Explicit records make the publicly exposed
  hostnames visible and intentional.
- A DNS-validation `TXT` record is needed only if the selected certificate or
  hosting provider explicitly asks for one.

## TTL

Use a TTL of approximately **300 seconds** while setting up or moving the demo.
After the environment is stable, increase it to approximately **3600 seconds**.

A short TTL reduces DNS cutover time but does not guarantee every resolver
honors it immediately. Keep the former environment available during the
TestFlight and DNS verification window when practical.

## Setup order

1. Select the real parent domain and confirm who controls its DNS.
2. Reserve the server's public IP or obtain the managed ingress hostname.
3. Decide whether the existing demo must stay online during cutover.
4. Create the four DNS records with a 300-second TTL.
5. Wait until public resolvers return the intended address.
6. Configure the HTTPS proxy routes for all four hostnames.
7. Open public ports 80 and 443 to the proxy.
8. Keep application ports 8090–8092 and Demo Control port 8099 private or bound
   to loopback.
9. Obtain and verify TLS certificates.
10. Update hosted application origins and CORS configuration.
11. Build and test a device build against the domains.
12. Produce the TestFlight build only after the device build works on Wi-Fi and
    cellular.
13. Remove the old `sslip.io` and Door instructions only after cutover passes.

## Proxy routing

The conceptual Caddy/ingress mapping is:

```text
waypoint.domain.com             -> 127.0.0.1:8090
northwood.waypoint.domain.com   -> 127.0.0.1:8092
content.waypoint.domain.com     -> 127.0.0.1:8091
control.waypoint.domain.com     -> 127.0.0.1:8099
```

The proxy still provides TLS, routing and security headers. Removing Door means
it no longer imports a generated visitor-IP allowlist or reloads every time a
salesperson changes networks.

Validate the proxy configuration before reloading it. On a Caddy host:

```bash
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

## Application configuration mapping

The hosted environment should ultimately use:

```text
WAYPOINT_APP_ORIGIN=https://waypoint.domain.com
WAYPOINT_CONTENT_ORIGIN=https://content.waypoint.domain.com
WAYPOINT_SAAS_ORIGIN=https://northwood.waypoint.domain.com
```

Northwood's server-to-server calls to Waypoint should continue to use the
private/internal service address. They should not leave the server and return
through the public proxy.

The mobile release configuration must use the same public application and
Northwood origins. The Demo Control hostname does not belong in ordinary
product API calls; it is a browser-only sales operations page.

Likely configuration touchpoints during implementation:

```text
spike/mobile/app.config.js
spike/mobile/config.js
spike/api/config.mjs
hosted environment variables
Caddy or managed ingress configuration
```

Do not change the local developer `WRITTEN_HOST` behavior as part of the domain
cutover. Local Mac-to-iPhone networking is a separate concern.

## DNS verification

Check each public record before changing the application:

```bash
dig +short waypoint.domain.com
dig +short northwood.waypoint.domain.com
dig +short content.waypoint.domain.com
dig +short control.waypoint.domain.com
```

After the proxy is configured, check HTTPS and routing:

```bash
curl -I https://waypoint.domain.com
curl -I https://northwood.waypoint.domain.com
curl -I https://content.waypoint.domain.com/player
curl -I https://control.waypoint.domain.com
```

Do not treat one successful laptop test as complete. Verify from:

- A normal home or office Wi-Fi connection.
- A network that was never previously allowed through Door.
- An iPhone over Wi-Fi.
- An iPhone over cellular.
- The device build, followed by the TestFlight build.

## TLS verification

Each hostname must:

- Present a valid, publicly trusted certificate.
- Name the requested hostname in the certificate.
- Redirect HTTP to HTTPS.
- Renew without manual intervention.

Caddy can obtain certificates automatically when public DNS resolves correctly
and ports 80/443 reach it. If a proxy/CDN is placed in front, follow that
provider's origin-certificate and TLS-mode requirements rather than creating a
second, conflicting certificate flow.

## Cutover checklist

- [ ] Public IP or ingress address is stable.
- [ ] Four DNS records resolve correctly.
- [ ] Four HTTPS certificates are valid.
- [ ] Content remains on a separate origin.
- [ ] Waypoint and Northwood sign-in work through their new names.
- [ ] A course launches, saves progress, resumes and completes.
- [ ] Demo Control is password-protected and can restore the baseline.
- [ ] TestFlight works on Wi-Fi and cellular.
- [ ] Direct application ports are not publicly reachable.
- [ ] The old Door/IP allowlist is no longer required for access.
- [ ] Rollback DNS and proxy configuration are saved.
- [ ] Documentation contains no real passwords, private keys or reset secrets.

## Rollback

Before cutover, save the old DNS values and proxy configuration.

If the new names fail:

1. Restore the prior proxy configuration.
2. Point DNS back to the former environment if it is still available.
3. Keep or restore the former TestFlight build while the new environment is
   repaired.
4. Do not remove the former Door service or configuration until the rollback
   window has passed.

Changing DNS does not repair a failed database or application deployment. Keep
the domain cutover, application deployment and database reset as separately
verifiable steps.
