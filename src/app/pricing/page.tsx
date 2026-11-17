import { getMonthlyLimit } from '@/lib/credits';
import PricingClient from './pricing-client';

/**
 * Server wrapper: reads each plan's monthly credit allowance from the same
 * function that enforces it, so the page can state real numbers and can never
 * drift from what the app actually grants.
 */
export default function PricingPage() {
  return <PricingClient credits={{ pro: getMonthlyLimit('pro'), max: getMonthlyLimit('max') }} />;
}
