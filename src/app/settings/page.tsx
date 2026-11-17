import { redirect } from 'next/navigation';

/** Settings has one home: the account page. Old /settings links land on Connections. */
export default function SettingsPage() {
  redirect('/account?tab=connections');
}
