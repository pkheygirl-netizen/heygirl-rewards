import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, Box, Text } from "@shopify/polaris";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({ appVersion: "0.1.0" });
};

export default function Index() {
  const { appVersion } = useLoaderData<typeof loader>();
  return (
    <Page title="HeyGirl Rewards">
      <Layout>
        <Layout.Section>
          <Card>
            <Box padding="400">
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Rewards Dashboard</Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  App v{appVersion} — full dashboard arriving Week 6.
                </Text>
              </BlockStack>
            </Box>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
